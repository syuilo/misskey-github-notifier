import * as http from 'http';
import { EventEmitter } from 'events';
import * as Koa from 'koa';
import * as Router from 'koa-router';
import * as bodyParser from 'koa-bodyparser';
import * as request from 'request';
const crypto = require('crypto');
const config = require('../config.json');

const handler = new EventEmitter();

const post = async (text: string, home = true) => {
	request.post(config.instance + '/api/notes/create', {
		json: {
			i: config.i,
			text, visibility: home ? 'home' : 'public'
		}
	});
};

const app = new Koa();
app.use(bodyParser());

const secret = config.hookSecret;

const router = new Router();

router.post('/github', ctx => {
	const body = JSON.stringify(ctx.request.body);
	const hash = crypto.createHmac('sha1', secret).update(body).digest('hex');
	const sig1 = Buffer.from(ctx.headers['x-hub-signature']);
	const sig2 = Buffer.from(`sha1=${hash}`);

	// シグネチャ比較
	if (sig1.equals(sig2)) {
		handler.emit(ctx.headers['x-github-event'], ctx.request.body);
		ctx.status = 204;
	} else {
		ctx.status = 400;
	}
});

app.use(router.routes());

const server = http.createServer(app.callback());

server.listen(config.port);

handler.on('status', event => {
	const state = event.state;
	switch (state) {
		case 'error':
		case 'failure':
			const commit = event.commit;
			const parent = commit.parents[0];

			// Fetch parent status
			request({
				url: `${parent.url}/statuses`,
				proxy: config.proxy,
				headers: {
					'User-Agent': 'misskey'
				}
			}, (err, res, body) => {
				if (err) {
					console.error(err);
					return;
				}
				const parentStatuses = JSON.parse(body);
				const parentState = parentStatuses[0]?.state;
				const stillFailed = parentState === 'failure' || parentState === 'error';
				if (stillFailed) {
					post(`⚠️**BUILD STILL FAILED**⚠️: ?[${commit.commit.message}](${commit.html_url})`);
				} else {
					post(`🚨**BUILD FAILED**🚨: →→→?[${commit.commit.message}](${commit.html_url})←←←`);
				}
			});
			break;
	}
});

handler.on('push', event => {
	const ref = event.ref;
	switch (ref) {
		case 'refs/heads/develop':
			const pusher = event.pusher;
			const compare = event.compare;
			const commits: any[] = event.commits;
			post([
				`🆕 Pushed by **${pusher.name}** with ?[${commits.length} commit${commits.length > 1 ? 's' : ''}](${compare}):`,
				commits.reverse().map(commit => `・[?[${commit.id.substr(0, 7)}](${commit.url})] ${commit.message.split('\n')[0]}`).join('\n'),
			].join('\n'));
			break;
	}
});

handler.on('issues', event => {
	const issue = event.issue;
	const action = event.action;
	let title: string;
	switch (action) {
		case 'opened': title = '[shake 💥] Issue opened'; break;
		case 'closed': title = '💮 Issue closed'; break;
		case 'reopened': title = '[shake 🔥] Issue reopened'; break;
		default: return;
	}
	post(`${title}: <${issue.number}>「${issue.title}」\n${issue.html_url}`);
});

handler.on('issue_comment', event => {
	const issue = event.issue;
	const comment = event.comment;
	const action = event.action;
	let text: string;
	switch (action) {
		case 'created': text = `💬 Commented to「${issue.title}」:${comment.user.login}「${comment.body}」\n${comment.html_url}`; break;
		default: return;
	}
	post(text);
});

handler.on('release', event => {
	const action = event.action;
	const release = event.release;
	let text: string;
	switch (action) {
		case 'published': text = `[twitch 🎁] **NEW RELEASE**: [${release.tag_name}](${release.html_url}) is out now. Enjoy!`; break;
		default: return;
	}
	post(text);
});

handler.on('watch', event => {
	const sender = event.sender;
	post(`[jelly ⭐️] Starred by ?[**${sender.login}**](${sender.html_url}) [jelly ⭐️]`, false);
});

handler.on('fork', event => {
	const sender = event.sender;
	const repo = event.forkee;
	post(`🍴 ?[Forked](${repo.html_url}) by ?[**${sender.login}**](${sender.html_url}) 🍴`);
});

handler.on('pull_request', event => {
	const pr = event.pull_request;
	const action = event.action;
	let text: string;
	switch (action) {
		case 'opened': text = `📦 New Pull Request:「${pr.title}」\n${pr.html_url}`; break;
		case 'reopened': text = `🗿 Pull Request Reopened:「${pr.title}」\n${pr.html_url}`; break;
		case 'closed':
			text = pr.merged
				? `💯 Pull Request Merged!:「${pr.title}」\n${pr.html_url}`
				: `🚫 Pull Request Closed:「${pr.title}」\n${pr.html_url}`;
			break;
		default: return;
	}
	post(text);
});
