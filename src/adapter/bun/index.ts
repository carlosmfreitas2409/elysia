/* eslint-disable sonarjs/no-duplicate-string */
import { Memoirist } from 'memoirist'
import type { TSchema } from '@sinclair/typebox'

import { WebStandardAdapter } from '../web-standard/index'
import { parseSetCookies } from '../utils'
import type { ElysiaAdapter } from '../types'
import type { Serve } from '../../universal/server'

import { createBunRouteHandler } from './compose'
import { createNativeStaticHandler } from './handler-native'

import { serializeCookie } from '../../cookies'
import { isProduction, ValidationError } from '../../error'
import { getSchemaValidator } from '../../schema'
import {
	hasHeaderShorthand,
	isNotEmpty,
	isNumericString,
	randomId
} from '../../utils'

import {
	mapResponse,
	mapEarlyResponse,
	mapCompactResponse,
	createStaticHandler
} from './handler'

import {
	createHandleWSResponse,
	createWSMessageParser,
	ElysiaWS,
	websocket
} from '../../ws/index'
import type { ServerWebSocket } from '../../ws/bun'
import { AnyElysia } from '../..'
import { Static } from '@sinclair/typebox/parser'

const optionalParam = /:.+?\?(?=\/|$)/

const getPossibleParams = (path: string) => {
	const match = optionalParam.exec(path)

	if (!match) return [path]

	const routes: string[] = []

	const head = path.slice(0, match.index)
	const param = match[0].slice(0, -1)
	const tail = path.slice(match.index + match[0].length)

	routes.push(head.slice(0, -1))
	routes.push(head + param)

	for (const fragment of getPossibleParams(tail)) {
		if (!fragment) continue

		if (!fragment.startsWith('/:'))
			routes.push(head.slice(0, -1) + fragment)

		routes.push(head + param + fragment)
	}

	return routes
}

const mapRoutes = (app: AnyElysia) => {
	if (!app.config.aot || !app.config.systemRouter) return undefined

	const routes = <Record<string, Function | Record<string, unknown>>>{}

	const add = (
		route: {
			path: string
			method: string
		},
		handler: Function
	) => {
		if (routes[route.path]) {
			// @ts-ignore
			if (!routes[route.path][route.method])
				// @ts-ignore
				routes[route.path][route.method] = handler
		} else
			routes[route.path] = {
				[route.method]: handler
			}
	}

	// @ts-expect-error
	const tree = app.routeTree

	for (const route of app.router.history) {
		if (typeof route.handler !== 'function') continue

		const method = route.method

		if ((method === 'GET' && `WS_${route.path}` in tree) || method === 'WS')
			continue

		if (method === 'ALL') {
			if (!(`WS_${route.path}` in tree))
				routes[route.path] = route.hooks?.config?.mount
					? route.hooks.trace ||
						app.event.trace ||
						// @ts-expect-error private property
						app.extender.higherOrderFunctions
						? createBunRouteHandler(app, route)
						: route.hooks.mount || route.handler
					: route.handler

			continue
		}

		let compiled: Function

		const handler = app.config.precompile
			? createBunRouteHandler(app, route)
			: (request: Request) => {
					if (compiled) return compiled(request)

					return (compiled = createBunRouteHandler(app, route))(
						request
					)
				}

		for (const path of getPossibleParams(route.path))
			add(
				{
					method,
					path
				},
				handler
			)
	}

	return routes
}

type Routes = Record<string, Function | Response | Record<string, unknown>>

const mergeRoutes = (r1: Routes, r2?: Routes) => {
	if (!r2) return r1

	for (const key of Object.keys(r2)) {
		if (r1[key] === r2[key]) continue

		if (!r1[key]) {
			r1[key] = r2[key]
			continue
		}

		if (r1[key] && r2[key]) {
			if (typeof r1[key] === 'function' || r1[key] instanceof Response) {
				r1[key] = r2[key]
				continue
			}

			r1[key] = {
				...r1[key],
				...r2[key]
			}
		}
	}

	return r1
}

export const BunAdapter: ElysiaAdapter = {
	...WebStandardAdapter,
	name: 'bun',
	handler: {
		mapResponse,
		mapEarlyResponse,
		mapCompactResponse,
		createStaticHandler,
		createNativeStaticHandler
	},
	composeHandler: {
		...WebStandardAdapter.composeHandler,
		headers: hasHeaderShorthand
			? 'c.headers=c.request.headers.toJSON()\n'
			: 'c.headers={}\n' +
				'for(const [k,v] of c.request.headers.entries())' +
				'c.headers[k]=v\n'
	},
	listen(app) {
		return (options, callback) => {
			if (typeof Bun === 'undefined')
				throw new Error(
					'.listen() is designed to run on Bun only. If you are running Elysia in other environment please use a dedicated plugin or export the handler via Elysia.fetch'
				)

			app.compile()

			if (typeof options === 'string') {
				if (!isNumericString(options))
					throw new Error('Port must be a numeric value')

				options = parseInt(options)
			}

			const staticRoutes = <Record<string, Response>>{}

			for (const [path, route] of Object.entries(app.router.response))
				if (route && !(route instanceof Promise))
					staticRoutes[path] = route

			const serve =
				typeof options === 'object'
					? ({
							development: !isProduction,
							reusePort: true,
							...(app.config.serve || {}),
							...(options || {}),
							// @ts-ignore
							routes: {
								...staticRoutes,
								...mapRoutes(app),
								// @ts-expect-error
								...app.config.serve?.routes
							},
							websocket: {
								...(app.config.websocket || {}),
								...(websocket || {})
							},
							fetch: app.fetch
							// error: outerErrorHandler
						} as Serve)
					: ({
							development: !isProduction,
							reusePort: true,
							...(app.config.serve || {}),
							// @ts-ignore
							routes: mergeRoutes(
								mergeRoutes(staticRoutes, mapRoutes(app)),
								// @ts-expect-error private property
								app.config.serve?.routes
							),
							websocket: {
								...(app.config.websocket || {}),
								...(websocket || {})
							},
							port: options,
							fetch: app.fetch
							// error: outerErrorHandler
						} as Serve)

			app.server = Bun.serve(serve as any) as any

			if (app.event.start)
				for (let i = 0; i < app.event.start.length; i++)
					app.event.start[i].fn(app)

			if (callback) callback(app.server!)

			process.on('beforeExit', () => {
				if (app.server) {
					app.server.stop?.()
					app.server = null

					if (app.event.stop)
						for (let i = 0; i < app.event.stop.length; i++)
							app.event.stop[i].fn(app)
				}
			})

			// @ts-expect-error private
			app.promisedModules.then(async () => {
				Bun?.gc(false)

				const staticRoutes = <Record<string, Response>>{}
				const asyncStaticRoutes = <Promise<Response | undefined>[]>[]
				const asyncStaticRoutesPath = <string[]>[]

				for (const [path, route] of Object.entries(app.router.response))
					if (route instanceof Promise) {
						asyncStaticRoutes.push(route)
						asyncStaticRoutesPath.push(path)
					} else if (route) staticRoutes[path] = route

				if (!app.server && !isNotEmpty(asyncStaticRoutes)) return

				const promises = await Promise.all(asyncStaticRoutes)
				for (let i = 0; i < promises.length; i++) {
					const route = promises[i]
					const path = asyncStaticRoutesPath[i]

					if (route) staticRoutes[path] = route
				}

				app.server?.reload({
					...serve,
					fetch: app.fetch,
					// @ts-ignore
					routes: mergeRoutes(
						mergeRoutes(staticRoutes, mapRoutes(app)),
						// @ts-expect-error private property
						app.config.serve?.routes
					)
				})
			})
		}
	},
	ws(app, path, options) {
		// eslint-disable-next-line @typescript-eslint/no-unused-vars
		const { parse, body, response, ...rest } = options

		const validateMessage = getSchemaValidator(body, {
			// @ts-expect-error private property
			modules: app.definitions.typebox,
			// @ts-expect-error private property
			models: app.definitions.type as Record<string, TSchema>,
			normalize: app.config.normalize
		})

		const validateResponse = getSchemaValidator(response as any, {
			// @ts-expect-error private property
			modules: app.definitions.typebox,
			// @ts-expect-error private property
			models: app.definitions.type as Record<string, TSchema>,
			normalize: app.config.normalize
		})

		const validateUpgradeData = getSchemaValidator(options.upgradeData, {
			// @ts-expect-error private property
			modules: app.definitions.typebox,
			// @ts-expect-error private property
			models: app.definitions.type as Record<string, TSchema>,
			normalize: app.config.normalize
		})

		app.route(
			'WS',
			path as any,
			async (context: any) => {
				// @ts-expect-error private property
				const server = app.getServer()

				// ! Enable static code analysis just in case resolveUnknownFunction doesn't work, do not remove
				// eslint-disable-next-line @typescript-eslint/no-unused-vars
				const { set, path, qi, headers, query, params } = context

				// @ts-ignore
				context.validator = validateResponse

				if (options.upgrade) {
					if (typeof options.upgrade === 'function') {
						const temp = options.upgrade(context as any)
						if (temp instanceof Promise) await temp
					} else if (options.upgrade)
						Object.assign(
							set.headers,
							options.upgrade as Record<string, any>
						)
				}

				if (set.cookie && isNotEmpty(set.cookie)) {
					const cookie = serializeCookie(set.cookie)

					if (cookie) set.headers['set-cookie'] = cookie
				}

				if (
					set.headers['set-cookie'] &&
					Array.isArray(set.headers['set-cookie'])
				)
					set.headers = parseSetCookies(
						new Headers(set.headers as any) as Headers,
						set.headers['set-cookie']
					) as any

				const handleResponse = createHandleWSResponse(validateResponse)
				const parseMessage = createWSMessageParser(parse)

				let _id: string | undefined

				let _beforeHandleData: any
				if (typeof options.beforeHandle === 'function') {
					const result = options.beforeHandle(context)
					_beforeHandleData = result instanceof Promise ? await result : result
				}

				const errorHandlers = [
					...(Array.isArray(options.error)
						? options.error
						: [options.error]),
					...(app.event.error ?? []).map((x) =>
						typeof x === 'function' ? x : x.fn
					)
				]

				const handleErrors = !errorHandlers.length
					? () => {}
					: async (ws: ServerWebSocket<any>, error: unknown) => {
							for (const handleError of errorHandlers) {
								let response = handleError(
									Object.assign(context, { error })
								)
								if (response instanceof Promise)
									response = await response

								await handleResponse(ws, response)

								if (response) break
							}
						}

				if (
					server?.upgrade<any>(context.request, {
						headers: isNotEmpty(set.headers)
							? (set.headers as Record<string, string>)
							: undefined,
						data: {
							...context,
							get id() {
								if (_id) return _id

								return (_id = randomId())
							},
							validator: validateResponse,
							ping(data?: unknown) {
								options.ping?.(data)
							},
							pong(data?: unknown) {
								options.pong?.(data)
							},
							open(ws: ServerWebSocket<any>) {
								if (validateUpgradeData?.Check(_beforeHandleData) === false) {
									return void ws.send(
										new ValidationError(
											'upgradeData',
											validateUpgradeData,
											_beforeHandleData
										).message as string
									)
								}

								try {
									handleResponse(
										ws,
										options.open?.(
											new ElysiaWS(ws, context as any),
											_beforeHandleData as any
										)
									)
								} catch (error) {
									handleErrors(ws, error)
								}
							},
							message: async (
								ws: ServerWebSocket<any>,
								_message: any
							) => {
								const message = await parseMessage(ws, _message)

								if (validateMessage?.Check(message) === false)
									return void ws.send(
										new ValidationError(
											'message',
											validateMessage,
											message
										).message as string
									)

								try {
									handleResponse(
										ws,
										options.message?.(
											new ElysiaWS(
												ws,
												context as any,
												message
											),
											message as any
										)
									)
								} catch (error) {
									handleErrors(ws, error)
								}
							},
							drain(ws: ServerWebSocket<any>) {
								try {
									handleResponse(
										ws,
										options.drain?.(
											new ElysiaWS(ws, context as any)
										)
									)
								} catch (error) {
									handleErrors(ws, error)
								}
							},
							close(
								ws: ServerWebSocket<any>,
								code: number,
								reason: string
							) {
								try {
									handleResponse(
										ws,
										options.close?.(
											new ElysiaWS(ws, context as any),
											code,
											reason
										)
									)
								} catch (error) {
									handleErrors(ws, error)
								}
							}
						}
					})
				)
					return

				set.status = 400
				return 'Expected a websocket connection'
			},
			{
				...rest,
				websocket: options
			} as any
		)
	}
}
