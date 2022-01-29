import os from 'node:os'
import fs from 'node:fs'
import path from 'node:path'
import makeDebugger from 'debug'
import { execaSync } from 'execa'
import { Plugin, UserConfig, loadEnv } from 'vite'
import { finish, wrap } from './utils'
import type { Certificates, Options, ResolvedConfiguration, ServerConfiguration } from './types'
import { updateAliases } from './alias'

const PREFIX = 'Laravel Vite'
const CONFIG_ARTISAN_COMMAND = 'vite:config'
const debug = makeDebugger('laravel:config')

/**
 * Calls an artisan command.
 */
export function callArtisan(executable: string, ...params: string[]): string {
	return execaSync(executable, ['artisan', ...params])?.stdout
}

/**
 * Calls a shell command.
 */
export function callShell(executable: string, ...params: string[]): string {
	return execaSync(executable, [...params])?.stdout
}

/**
 * Reads the configuration from the `php artisan vite:config` command.
 */
export function readConfig(options: Options, env: Record<string, string>, name?: string): ResolvedConfiguration {
	try {
		// Sets path from environment variable
		if (options.config !== false && env.CONFIG_PATH_VITE) {
			debug('Setting configuration file path to CONFIG_PATH_VITE.')
			options.config = env.CONFIG_PATH_VITE
		}

		// Reads the config from the disk
		if (typeof options.config === 'string') {
			debug(`Reading configuration from ${options.config}`)
			const json = JSON.parse(fs.readFileSync(options.config, { encoding: 'utf-8' })) as ServerConfiguration

			return <ResolvedConfiguration>{
				commands: json.commands,
				aliases: json.aliases,
				...json.configs[name ?? json.default],
			}
		}

		// Returns the given config
		if (typeof options.config === 'object') {
			debug('Reading configuration from the given object.')

			return options.config
		}

		// Asks PHP for the configuration
		debug('Reading configuration from PHP.')
		const executable = env.PHP_EXECUTABLE || options?.phpExecutable || 'php'
		const json = JSON.parse(callArtisan(executable, CONFIG_ARTISAN_COMMAND)) as ServerConfiguration

		return <ResolvedConfiguration>{
			commands: json.commands,
			aliases: json.aliases,
			...json.configs[name ?? json.default],
		}
	} catch (error: any) {
		throw new Error(`[${PREFIX}] Could not read configuration: ${error.message}`)
	}
}

/**
 * Finds the current configuration name.
 */
function findConfigName(): string | undefined {
	const configIndex = process.argv.findIndex((arg) => ['-c', '--config'].includes(arg))

	if (!configIndex) {
		return
	}

	const fileNameRegex = /vite\.([\w-]+)\.config\.ts/
	const configFile = process.argv.at(configIndex + 1)

	return fileNameRegex.exec(configFile || '')?.at(1)?.trim()
}

/**
 * Loads the Laravel Vite configuration.
 */
export const config = (options: Options = {}): Plugin => ({
	name: 'laravel:config',
	enforce: 'post',
	config: (baseConfig, { command, mode }) => {
		// Loads .env
		const env = loadEnv(mode, process.cwd(), '')

		// Loads config
		const configName = findConfigName()
		debug('Config name:', configName ?? 'not found, using default')
		const serverConfig = readConfig(options, env, configName)
		debug('Configuration from PHP:', serverConfig)

		// Sets base
		const base = finish(`${finish(env.ASSET_URL, '/', '/')}${command === 'build' ? `${serverConfig.build_path}/` : ''}`, '/')
		debug('Base URL:', base || '<empty>')

		// Parses dev url
		const { protocol, hostname, port } = new URL(serverConfig.dev_server.url || 'http://localhost:3000')
		const { key, cert } = findCertificates(env, hostname)
		const usesHttps = key && cert && protocol === 'https:'
		debug('Uses HTTPS:', usesHttps, { key, cert, protocol, hostname, port })

		// Entrypoints
		const ssr = process.argv.includes('--ssr')
		const entrypoints = ssr ? serverConfig.entrypoints.ssr : serverConfig.entrypoints.paths

		// Runs commands
		const executable = env.PHP_EXECUTABLE || options?.phpExecutable || 'php'
		Object.entries(serverConfig.commands?.artisan ?? {}).forEach(([command, args]) => {
			if (!isNaN(+command)) {
				debug('Running artisan command without arguments:', executable, 'artisan', args)
				debug(callArtisan(executable, args))

				return
			}

			debug('Running artisan command:', executable, 'artisan', command, ...args)
			debug(callArtisan(executable, command, ...args))
		})

		Object.entries(serverConfig.commands?.shell ?? {}).forEach(([command, args]) => {
			if (!isNaN(+command)) {
				debug('Running shell command without arguments:', args)
				debug(callShell(args))

				return
			}

			debug('Running shell command:', command, ...args)
			debug(callShell(command, ...args))
		})

		// Updates aliases
		if (command !== 'build' && options.updateTsConfig !== false) {
			updateAliases(serverConfig.aliases)
		}

		// Returns config
		const resolvedConfig: UserConfig = {
			envPrefix: wrap(options.envPrefix, ['MIX_', 'VITE_', 'SCRIPT_']),
			base,
			publicDir: serverConfig.public_directory ?? 'resources/static',
			server: {
				host: hostname,
				https: usesHttps
					? { maxVersion: 'TLSv1.2', key, cert }
					: protocol === 'https:',
				port: port ? Number(port) : 3000,
				origin: `${protocol}//${hostname}:${port}`,
				hmr: {
					host: hostname,
					port: Number(port) || 3000,
				},
			},
			build: {
				assetsDir: 'assets',
				ssrManifest: ssr,
				manifest: !ssr,
				ssr,
				outDir: `public/${serverConfig.build_path ?? 'build'}`,
				rollupOptions: {
					input: entrypoints,
				},
			},
			resolve: {
				alias: Object.fromEntries(Object.entries(serverConfig.aliases || {}).map(([alias, directory]) => {
					return [alias, path.join(process.cwd(), directory)]
				})),
			},
			css: { postcss: options.postcss ? { plugins: options.postcss } : baseConfig.css?.postcss },
		}

		debug('Resolved config:', resolvedConfig)

		return resolvedConfig
	},
})

/**
 * Tries to find certificates from the environment.
 */
export function findCertificates(env: Record<string, string>, hostname?: string): Certificates {
	let key = env.DEV_SERVER_KEY || ''
	let cert = env.DEV_SERVER_CERT || ''

	if (!key || !cert) {
		switch (os.platform()) {
			case 'darwin': {
				const home = os.homedir()
				const domain = hostname
				const valetPath = '/.config/valet/Certificates/'

				key ||= `${home}${valetPath}${domain}.key`
				cert ||= `${home}${valetPath}${domain}.crt`

				debug('Automatically set certificates for Valet:', {
					home,
					domain,
					valetPath,
					key,
					cert,
				})

				break
			}

			case 'win32': {
				// Detect Laragon in PATH
				let laragonDirectory = process.env.PATH?.split(';').find((l) => l.toLowerCase().includes('laragon'))

				if (!laragonDirectory) {
					break
				}

				laragonDirectory = laragonDirectory.split('\\bin')[0]

				if (laragonDirectory.endsWith('\\')) {
					laragonDirectory = laragonDirectory.slice(0, -1)
				}

				key ||= `${laragonDirectory}\\etc\\ssl\\laragon.key`
				cert ||= `${laragonDirectory}\\etc\\ssl\\laragon.crt`

				debug('Automatically set certificates for Laragon:', {
					laragonDirectory,
					key,
					cert,
				})

				break
			}
		}
	}

	return {
		key,
		cert,
	}
}