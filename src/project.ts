import 'vs/editor/editor.main'; /* imported for side-effects */

import { ProjectBundle, ProjectFile, ProjectFileType } from '@dojo/cli-emit-editor/interfaces/editor';
import Evented from '@dojo/core/Evented';
import { assign } from '@dojo/core/lang';
import request from '@dojo/core/request';
import { find, includes } from '@dojo/shim/array';
import WeakMap from '@dojo/shim/WeakMap';
import { OutputFile } from 'typescript';

import { EmitFile, TypeScriptWorker } from './interfaces';

interface ProjectFileData {
	/**
	 * Set to `true` if the model for the file has been updated in the editor, otherwise `false`.
	 */
	dirty?: boolean;

	/**
	 * The associated monaco-editor model for a project file object.
	 */
	model?: monaco.editor.IModel;
}

/**
 * Create a monaco-editor model for the specified project file
 * @param param0 The project file to create the model from
 */
function createMonacoModel({ name: filename, text, type }: ProjectFile): monaco.editor.IModel {
	return monaco.editor.createModel(text, getLanguageFromType(type), monaco.Uri.file(filename));
}

/**
 * Convert a `ProjectFileType` to a monaco-editor language
 * @param type The type to get a monaco-editor language for
 */
function getLanguageFromType(type: ProjectFileType): string {
	switch (type) {
	case ProjectFileType.Definition:
	case ProjectFileType.TypeScript:
	case ProjectFileType.Lib:
		return 'typescript';
	case ProjectFileType.HTML:
		return 'html';
	case ProjectFileType.JavaScript:
		return 'javascript';
	case ProjectFileType.Markdown:
		return 'markdown';
	case ProjectFileType.CSS:
		return 'css';
	case ProjectFileType.JSON:
		return 'json';
	case ProjectFileType.PlainText:
		return 'plaintext';
	case ProjectFileType.XML:
		return 'xml';
	default:
		return 'unknown';
	}
}

export class Project extends Evented {
	/**
	 * The loaded project bundle structure
	 */
	private _project: ProjectBundle | undefined;

	/**
	 * A map of meta data related to project files
	 */
	private _fileMap = new WeakMap<ProjectFile, ProjectFileData>();

	/**
	 * An async function which resolves with the parsed text of the project bundle
	 * @param filename The filename to load the bundle from
	 */
	private async _loadBundle(filename: string): Promise<void> {
		this._project = JSON.parse(await (await request(filename)).text());
	}

	/**
	 * Retrieve the project file meta data being tracked by the project
	 * @param file The project file
	 */
	private _getProjectFileData(file: ProjectFile): ProjectFileData {
		if (!this._fileMap.has(file)) {
			this._fileMap.set(file, {});
		}
		return this._fileMap.get(file);
	}

	/**
	 * Flush any changes that have come from the editor back into the project files.
	 */
	private _updateBundle(): void {
		if (!this._project) {
			return;
		}
		this._project.files
			.filter(({ name }) => this.isFileDirty(name))
			.forEach((file) => {
				file.text = this.getFileModel(file.name).getValue();
				this.setFileDirty(file.name, true);
			});
	}

	/**
	 * The the environment files in the monaco-editor environment.  These are the "non-editable" files which support the
	 * project and are usually additional type definitions that the project depends upon.
	 */
	private _setEnvironmentFiles(): void {
		this._project!.environmentFiles.forEach(({ name: filename, text, type }) => {
			monaco.languages.typescript.typescriptDefaults.addExtraLib(text, (type === ProjectFileType.Lib ? '' : 'file:///') + filename);
		});
	}

	/**
	 * Ensure that any TypeScript project fies are part of the environment, so that TypeScript files can be edited with
	 * the full context of the project.
	 */
	private _setProjectFiles(): void {
		this._project!.files.forEach(({ name: filename, text, type }) => {
			if (type === ProjectFileType.TypeScript || type === ProjectFileType.Definition) {
				monaco.languages.typescript.typescriptDefaults.addExtraLib(text, 'file:///' + filename);
			}
		});
	}

	/**
	 * Set the compiler options for the TypeScript environment based on what is provided by the project bundle, combined
	 * with additional settings that are required for use in the web-editor.
	 */
	private _setTypeScriptEnvironment(): void {
		const { compilerOptions = {} } = this._project!.tsconfig;
		const options: monaco.languages.typescript.CompilerOptions = {};

		/* copied from tsconfig.json */
		const { lib, noImplicitAny, noImplicitThis, noImplicitReturns, noLib, noUnusedLocals, noUnusedParameters, strictNullChecks, types } = compilerOptions;
		assign(options, {
			lib,
			noImplicitAny,
			noImplicitThis,
			noImplicitReturns,
			noLib,
			noUnusedLocals,
			noUnusedParameters,
			strictNullChecks,
			types
		});

		/* asserted for web editing */
		assign(options, {
			allowNonTsExtensions: true,
			target: monaco.languages.typescript.ScriptTarget.ES5,
			module: monaco.languages.typescript.ModuleKind.UMD,
			moduleResolution: monaco.languages.typescript.ModuleResolutionKind.NodeJs
		});

		monaco.languages.typescript.typescriptDefaults.setCompilerOptions(options);
	}

	/**
	 * Take the currently loaded project and emit it
	 */
	async emit(): Promise<EmitFile[]> {
		if (!this._project) {
			throw new Error('Project not loaded.');
		}
		const typescriptFileUris = this._project.files
			.filter(({ type }) => type === ProjectFileType.Definition || type === ProjectFileType.TypeScript)
			.map(({ name }) => this.getFileModel(name).uri);
		const worker: TypeScriptWorker = await monaco.languages.typescript.getTypeScriptWorker();
		const client = await worker(...typescriptFileUris);
		const output = await Promise.all(typescriptFileUris.map((file) => client.getEmitOutput(file.toString())));
		return output
			.reduce((previous, output) => { /* get emitted typescript files */
				if (output.emitSkipped) {
					return previous;
				}
				return previous.concat(output.outputFiles);
			}, [] as OutputFile[])
			.map(({ text, name }) => { return { text, name: name.replace('file://', '') }; }) /* conform to emitted file format */
			.concat(this._project.files /* add on other project files */
				.filter(({ type }) => type !== ProjectFileType.Definition && type !== ProjectFileType.TypeScript)
				.map(({ name }) => this.getFileModel(name))
				.map((model) => { return { name: model.uri.fsPath.replace(/\/\.\//, '/'), text: model.getValue() }; }));
	}

	/**
	 * Return the currently loaded project bundle.
	 */
	get(): ProjectBundle | undefined {
		this._updateBundle();
		return this._project;
	}

	/**
	 * Retrieve a project file based on the file name from the project bundle, or return `undefined` if the file is not part of
	 * the project.
	 * @param filename The file name of the project file
	 */
	getFile(filename: string): ProjectFile | undefined {
		if (!this._project) {
			throw new Error('Project not loaded.');
		}
		return find(this._project.files, ({ name }) => name === filename);
	}

	/**
	 * Return a monaco-editor model for a specified file name.  Will throw if the filename is not part of the project.
	 * @param filename The file name of the project file
	 */
	getFileModel(filename: string): monaco.editor.IModel {
		const file = this.getFile(filename);
		if (!file) {
			throw new Error(`File "${filename}" is not part of the project.`);
		}
		const fileData = this._getProjectFileData(file);
		if (!fileData.model) {
			fileData.model = createMonacoModel(file);
		}
		return fileData.model;
	}

	/**
	 * Return an array of strings which are the names of the project files associated with the project.  By default it returns
	 * all of the files, but to filter based on file type, pass additional arguments of the file types to filter on.
	 * @param types Return only files that match these project file types
	 */
	getFiles(...types: ProjectFileType[]): string[] {
		if (!this._project) {
			throw new Error('Project not loaded.');
		}
		return this._project.files
			.filter(({ type }) => types.length ? includes(types, type) : true)
			.map(({ name }) => name);
	}

	/**
	 * Return `true` if the specified file name is part of the project, otherwise `false`.
	 * @param filename The file name
	 */
	includes(filename: string): boolean {
		return Boolean(this._project && includes(this.getFiles(), filename));
	}

	/**
	 * Determine if a file, by name is _dirty_ and has not had its contents updated in the project bundle once being edited
	 * in the editor.
	 * @param filename The file name
	 */
	isFileDirty(filename: string): boolean {
		const file = this.getFile(filename);
		return Boolean(file && this._getProjectFileData(file).dirty);
	}

	/**
	 * Returns `true` if the project is loaded, otherwise `false`
	 */
	isLoaded(): boolean {
		return Boolean(this._project);
	}

	/**
	 * An async function which loads a project JSON bundle file and sets the monaco-editor environment to be
	 * to edit the project.
	 * @param filename The project bundle to load
	 */
	async load(filename: string): Promise<void> {
		if (this._project) {
			throw new Error('Project is already loaded.');
		}
		await this._loadBundle(filename);
		this._setTypeScriptEnvironment();
		this._setEnvironmentFiles();
		this._setProjectFiles();
	}

	/**
	 * Set (or unset) the file _dirty_ flag on a project file
	 * @param filename The file name
	 * @param reset Set to `true` to unset the _dirty_ flag on the file
	 */
	setFileDirty(filename: string, reset?: boolean): void {
		const file = this.getFile(filename);
		if (!file) {
			throw new Error(`File "${filename}" is not part of the project.`);
		}
		if (file) {
			this._getProjectFileData(file).dirty = !reset;
		}
	}
}

/* create singleton instance of project for default export */
const project = new Project();
export default project;
