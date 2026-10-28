import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { SETUP_USAGE, parseSetupArgs } from '../src/setup/args.js';
import { mergeEnvText, parseEnvText } from '../src/setup/envFile.js';
import { CALLBACKS, TENANT_EVENTS, TENANT_SCOPES, buildAddons } from '../src/setup/presets.js';
describe('parseSetupArgs', () => {
    it('defaults to Feishu, no app id, help off', () => {
        const args = parseSetupArgs([], {});
        assert.equal(args.domain, 'feishu');
        assert.equal(args.appId, undefined);
        assert.equal(args.force, false);
        assert.equal(args.start, undefined);
        assert.equal(args.help, false);
    });
    it('tolerates the -- separator and reads --no-start for scripts', () => {
        const args = parseSetupArgs(['--', '--no-start'], {});
        assert.equal(args.start, false);
    });
    it('honours FEISHU_DOMAIN but lets flags win', () => {
        assert.equal(parseSetupArgs([], { FEISHU_DOMAIN: 'lark' }).domain, 'lark');
        assert.equal(parseSetupArgs(['--feishu'], { FEISHU_DOMAIN: 'lark' }).domain, 'feishu');
        assert.equal(parseSetupArgs(['--domain', 'lark'], {}).domain, 'lark');
    });
    it('reads spaced and inline values', () => {
        const spaced = parseSetupArgs(['--app-id', 'cli_abc', '--home', 'oc_1', '--cwd', 'src'], {});
        assert.equal(spaced.appId, 'cli_abc');
        assert.equal(spaced.homeChannel, 'oc_1');
        assert.equal(spaced.piCwd, 'src');
        const inline = parseSetupArgs(['--app-id=cli_abc', '--name=我的 Pi'], {});
        assert.equal(inline.appId, 'cli_abc');
        assert.equal(inline.name, '我的 Pi');
    });
    it('toggles force/start and detects --help', () => {
        assert.equal(parseSetupArgs(['--force'], {}).force, true);
        assert.equal(parseSetupArgs(['--no-start'], {}).start, false);
        assert.equal(parseSetupArgs(['--start'], {}).start, true);
        assert.equal(parseSetupArgs(['-h'], {}).help, true);
    });
    it('rejects unknown flags with the usage text', () => {
        assert.throws(() => parseSetupArgs(['--nope'], {}), (error) => error instanceof Error &&
            error.message.startsWith('未知参数 --nope') &&
            error.message.includes(SETUP_USAGE));
    });
});
describe('mergeEnvText', () => {
    it('replaces existing keys and keeps comments and order', () => {
        const original = ['# 顶部注释', 'FEISHU_APP_ID=old', 'LOG_LEVEL=debug', ''].join('\n');
        const merged = mergeEnvText(original, { FEISHU_APP_ID: 'new' });
        assert.equal(merged, ['# 顶部注释', 'FEISHU_APP_ID=new', 'LOG_LEVEL=debug', ''].join('\n'));
    });
    it('appends missing keys once', () => {
        const merged = mergeEnvText('LOG_LEVEL=info\n', {
            FEISHU_APP_ID: 'cli_1',
            FEISHU_APP_SECRET: 's',
        });
        assert.match(merged, /LOG_LEVEL=info/);
        assert.match(merged, /# 由 npm run setup 自动写入/);
        assert.match(merged, /FEISHU_APP_ID=cli_1/);
        assert.match(merged, /FEISHU_APP_SECRET=s/);
        assert.equal(merged.match(/FEISHU_APP_ID=/g)?.length, 1);
    });
    it('creates a file from scratch and stays stable when re-run', () => {
        const first = mergeEnvText('', { FEISHU_APP_ID: 'cli_1' });
        assert.equal(first, '# 由 npm run setup 自动写入\nFEISHU_APP_ID=cli_1\n');
        const second = mergeEnvText(first, { FEISHU_APP_ID: 'cli_2' });
        assert.equal(second, '# 由 npm run setup 自动写入\nFEISHU_APP_ID=cli_2\n');
    });
    it('skips empty values so secrets are not wiped', () => {
        const merged = mergeEnvText('FEISHU_APP_SECRET=keep\n', { FEISHU_APP_SECRET: '' });
        assert.match(merged, /FEISHU_APP_SECRET=keep/);
    });
});
describe('parseEnvText', () => {
    it('reads plain, exported and quoted values', () => {
        const values = parseEnvText(['A=1', 'export B=2', 'C="x y"', "D='z'", '# E=9'].join('\n'));
        assert.deepEqual(values, { A: '1', B: '2', C: 'x y', D: 'z' });
    });
});
describe('buildAddons', () => {
    it('prefills scopes, events and callbacks for the scan flow', () => {
        const addons = buildAddons();
        assert.equal(addons.preset, true);
        assert.deepEqual(addons.scopes?.tenant, [...TENANT_SCOPES]);
        assert.deepEqual(addons.events?.items?.tenant, [...TENANT_EVENTS]);
        assert.deepEqual(addons.callbacks?.items, [...CALLBACKS]);
    });
    it('accepts extra scopes without mutating the defaults', () => {
        const addons = buildAddons(['drive:drive:readonly']);
        assert.ok(addons.scopes?.tenant?.includes('drive:drive:readonly'));
        assert.equal(TENANT_SCOPES.includes('drive:drive:readonly'), false);
    });
});
