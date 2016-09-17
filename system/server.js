"use strict";
let log;
let http = require('http');
let async = require('async');
let init;
let config;

exports.start = (paths, conf) => {
	config = conf;
	global.logger = require('./logger.js').logger(config.logPath, config.debug);
	log = global.logger.create('SRV');
	init = require('./init.js')
	
	let server = http.createServer(requestFunc);
	server.listen(conf.port || 8080);
	if(conf.disableNagleAlgoritm == true){
		server.on('connection', socket => {
			socket.setNoDelay(); // Отключаем алгоритм Нагла.
		});
	}
	log.i('server started on port: ' + conf.port || 8080);
	init.initDALs(paths, conf);
	init.initModules(paths, conf);
}

if(process.send){
	let intervals = {
		si: setInterval(() => {
			for(let i in intervals.funcs){
				intervals.funcs[i](() => {
					intervals.del(i);
				});
			}
		}, 1000),
		funcs: [],
		add: function(f){
			this.funcs.push(f);
		},
		del: function(ind){
			this.funcs.splice(ind, 1);
		}
	}
	let pings = [];
	process.on('message', obj=> {
		switch(obj.type){
			case 'start': 
				exports.start(obj.paths, obj.config);
				break;
			case 'ping':
				process.send({
					type: 'pong',
					id: obj.id
				});
				break;
			case 'pong':
				let ind = pings.indexOf(obj.id);
				if(ind > -1){
					pings.splice(ind, 1);
				}
				break;
			case 'reload':
				process.exit(0);
				break
			case 'exit':
				process.exit(1);
				break;

		}
	});
	intervals.add((deleteInterval) => {
		if(pings.length > 2){
			deleteInterval();
			process.exit(0);
			return;
		}
		let ping = {
			type: 'ping',
			id: Date.now()
		};
		pings.push(ping.id);
		process.send(ping);
	}, 1000);
}

process.on('uncaughtException', err => (log && log.c || console.log)('Caught exception:', err));

function requestFunc(request, response){
	let requestObject = init.parseRequest(request, response, config);
	
	let module = init.getModule(requestObject.path);
	if(!module){
		log.d('BAD', requestObject.headers['x-forwarded-for'] ||
			request.connection.remoteAddress ||
			request.socket.remoteAddress ||
			request.connection.socket.remoteAddress,
			'REQ: ' + requestObject.path
		);

		return requestObject.end('Error 404<title>' + config.error_title + '</title>', 404);
	}

	if(!init.auth(module, requestObject)){
		return requestObject.end('Access denied', 401, {'WWW-Authenticate': 'Basic realm="example"'});
	}

	async.auto({
		post: cb => requestObject.parsePost(cb),
		prerun: cb => {
			if(!module.meta.prerun){
				return cb();
			}

			module.meta.prerun(requestObject, module.meta, cb);
		},
		module: ['post', 'prerun', (res, cb) => {
			let poolId = requestObject.params.poolingId || requestObject.post.poolingId;
			let withPool = requestObject.params.withPooling || requestObject.post.withPooling;
			let next = cb;

			if(poolId){
				if(!init.pools[poolId]){
					return next('BAD_POOL_ID');
				}

				return next(null, init.pools[poolId]);
			}
			else if(withPool){
				let id = init.helpers.generateId();
				init.pools[id] = {
					poolingId: id
				};

				cb(null, init.pools[id]);
				next = (err, res) => {
					init.pools[id] = res;
				};
			}

			try{
				module.func(requestObject, (e, data, code, headers, type) => {
					if(e){
						data = {error: e};
						code = 200;
						headers = {'Content-Type': 'application/json'};
						type = null;
					}

					res.data = data;
					res.code = code || 200;
					res.headers = headers || {};
					res.type = type;
					next();
				});
			}
			catch(e){
				log.e(e);
				next(e);
			}
		}],
		json: ['module', (res, cb) =>{
			if(module.meta.toJson || module.meta.contentType == 'json' || res.headers['Content-Type'] == 'application/json'){
				init.helpers.toJson(res);
			}

			cb();
		}]
	},
	(err, res) => {
		if(module.meta && module.meta.skipRequestLog !== true){
			log.i(
				requestObject.headers['x-forwarded-for'] ||
					request.connection.remoteAddress ||
					request.socket && request.socket.remoteAddress ||
					request.connection.socket && request.connection.socket.remoteAddress,
				'REQ: ' + requestObject.path,
				'FROM: ' + (requestObject.headers.referer || '---'),
				'GET: ' + init.helpers.clearObj(requestObject.params),
				'POST: ' + init.helpers.clearObj(requestObject.post),
				'len:' + (res.data && res.data.length),
				module.meta.auth ? '(A)' : ''
			);
		}

		if(err){
			return requestObject.error(err);
		}

		requestObject.end(res.data, res.code, res.headers, res.type);
	});
}