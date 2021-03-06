import * as webpack from 'webpack';
import { existsSync } from 'fs';
import { resolve, join, sep, isAbsolute } from 'path';
import HtmlWebpackPlugin = require('html-webpack-plugin');

// loaders
const { BundleAnalyzerPlugin } = require('webpack-bundle-analyzer-sunburst');
const OptimizeCssAssetsPlugin = require('optimize-css-assets-webpack-plugin');
const ExtractTextPlugin = require('extract-text-webpack-plugin');
const postcssImport = require('postcss-import');
const postcssCssNext = require('postcss-cssnext');

// plugins
import CoreLoadPlugin from '@dojo/cli-build-webpack/plugins/CoreLoadPlugin';
const CopyWebpackPlugin = require('copy-webpack-plugin');
const { IgnorePlugin, NormalModuleReplacementPlugin, ContextReplacementPlugin, optimize: { UglifyJsPlugin } } = webpack;

function isRelative(id: string): boolean {
	const first = id.charAt(0);
	return first !== '/' && first !== '@' && /^\W/.test(id);
}

const basePath = __dirname;
const localIdentName = '[hash:base64:8]';
const cssLoader = ExtractTextPlugin.extract({
	use: 'css-loader?sourceMap!resolve-url-loader'
});
const cssModuleLoader = ExtractTextPlugin.extract({
	use: [
		'@dojo/webpack-contrib/css-module-decorator-loader',
		`css-loader?modules&sourceMap&importLoaders=1&localIdentName=${localIdentName}!resolve-url-loader`,
		{
			loader: 'postcss-loader?sourceMap',
			options: {
				plugins: [
					postcssImport,
					postcssCssNext({
						features: {
							autoprefixer: {
								browsers: ['last 2 versions', 'ie >= 10']
							}
						}
					})
				]
			}
		}
	]
});

const webpackConfig = (env: any = {}, args: any) => {
	return {
		entry: {
			'main': './src/index.ts',
			'support/providers/amdRequire': './src/support/providers/amdRequire.ts',
			'support/worker-proxy': './src/support/worker-proxy.ts'
		},
		output: {
			libraryTarget: 'umd',
			filename: '[name].js',
			path: resolve(__dirname, 'dist')
		},
		context: basePath,
		module: {
			rules: [
				{
					test: /\.tsx?$/,
					enforce: 'pre',
					loader: 'tslint-loader',
					options: {
						tsConfigFile: resolve(__dirname, 'tslint.json')
					}
				},
				{
					test: /@dojo\/.*\.js$/,
					enforce: 'pre',
					loader: 'source-map-loader-cli',
					options: { includeModulePaths: true }
				},
				{
					test: /src[\\\/].*\.ts?$/,
					enforce: 'pre',
					loader: '@dojo/webpack-contrib/css-module-dts-loader?type=ts&instanceName=0_dojo'
				},
				{
					test: /src[\\\/].*\.m\.css?$/,
					enforce: 'pre',
					loader: '@dojo/webpack-contrib/css-module-dts-loader?type=css'
				},
				{
					test: /src[\\\/].*\.ts(x)?$/,
					use: [
						'umd-compat-loader',
						{
							loader: 'ts-loader',
							options: { instance: 'dojo' }
						}
					]
				},
				{
					test: /\.js?$/,
					loader: 'umd-compat-loader'
				},
				{
					test: new RegExp(`globalize(\\${sep}|$)`),
					loader: 'imports-loader?define=>false'
				},
				{
					test: /.*\.(gif|png|jpe?g|svg|eot|ttf|woff|woff2)$/i,
					loader: 'file-loader?hash=sha512&digest=hex&name=[hash:base64:8].[ext]'
				},
				{
					test: /\.css$/, exclude: /src[\\\/].*/,
					loader: cssLoader
				},
				{
					test: /src[\\\/].*\.css?$/,
					loader: cssModuleLoader
				},
				{
					test: /\.m\.css\.js$/,
					exclude: /src[\\\/].*/,
					use: ['json-css-module-loader']
				},
				{
					test: /tests[\\\/].*\.ts?$/,
					use: [
						'umd-compat-loader',
						{
							loader: 'ts-loader',
							options: { instance: 'dojo' }
						}
					]
				}
			]
		},
		plugins: [
			new HtmlWebpackPlugin({
				template: 'src/index.html',
				excludeChunks: [
					'support/providers/amdRequire',
					'support/worker-proxy'
				],
				inject: 'body'
			}),
			new NormalModuleReplacementPlugin(/\.m\.css$/, (result: any) => {
				if (isAbsolute(result.request)) {
					return;
				}
				const requestFileName = isRelative(result.request) ?
					resolve(result.context, result.request) : resolve(basePath, 'node_modules', result.request);
				const jsFileName = requestFileName + '.js';

				if (existsSync(jsFileName)) {
					result.request = result.request.replace(/\.m\.css$/, '.m.css.js');
				}
			}),
			...(() => {
				let distPlugins: any[] = [];

				if (env.dist) {
					console.log('\n\n\nDIST\n\n\n');
					distPlugins = [
						new UglifyJsPlugin({
							sourceMap: true,
							compress: { warnings: false },
							exclude: /tests[/]/
						}),
						new OptimizeCssAssetsPlugin({
							cssProcessorOptions: { map: { inline: false } }
						}),
						new BundleAnalyzerPlugin({
							analyzerMode: 'static',
							openAnalyzer: false,
							reportType: 'sunburst'
						})
					];
				}

				return distPlugins;
			})(),
			new IgnorePlugin(/request\/providers\/node/),
			new ContextReplacementPlugin(/dojo-app[\\\/]lib/, { test: () => false }),
			new ContextReplacementPlugin(/.*/, { test: () => false }),
			new ExtractTextPlugin({ filename: 'main.css', allChunks: true }),
			new CopyWebpackPlugin([
				{ context: 'src', from: '**/*', ignore: '*.ts' },
				{ from: resolve(__dirname, 'projects'), to: 'projects' },
				{ from: resolve(__dirname, 'data'), to: 'data' },
				{ from: resolve(__dirname, 'extensions'), to: 'extensions' },
				{ from: resolve(__dirname, 'node_modules/monaco-editor/min/vs'), to: 'vs' }
			]),
			new CoreLoadPlugin({ basePath })
		],
		node: {
			dgram: 'empty',
			net: 'empty',
			tls: 'empty',
			fs: 'empty'
		},
		resolveLoader: {
			modules: [
				resolve(__dirname, 'node_modules/@dojo/cli-build-webpack/loaders'),
				join(__dirname, 'node_modules')
			],
			extensions: [ '.ts', '.js' ]
		},
		resolve: {
			extensions: ['.ts', '.js']
		},
		devtool: 'cheap-module-eval-source-map'
	};
};

export default webpackConfig;
