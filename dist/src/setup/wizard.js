import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
export function parseWizardArgs(argv) {
    const [domain, createOnly, appId, resultFile] = argv;
    if (domain !== 'feishu' && domain !== 'lark')
        return undefined;
    if (createOnly !== '0' && createOnly !== '1')
        return undefined;
    if (!resultFile)
        return undefined;
    return {
        domain,
        createOnly: createOnly === '1',
        appId: appId && appId !== '-' ? appId : undefined,
        resultFile,
    };
}
/**
 * A result path the extension handed us: inside a private directory it
 * created. Anything else is refused, so a stray argument can never point the
 * wizard at an arbitrary file.
 */
export function isWizardResultPath(file) {
    const resolved = path.resolve(file);
    const parent = path.dirname(resolved);
    const base = path.basename(resolved);
    if (base !== 'result.json')
        return false;
    const tmp = path.resolve(os.tmpdir());
    const relative = path.relative(tmp, parent);
    return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative);
}
/** Persist the outcome; a path outside the wizard's own directory is refused. */
export function writeWizardResult(file, result) {
    if (!isWizardResultPath(file))
        return false;
    try {
        writeFileSync(file, `${JSON.stringify(result, null, 2)}\n`, 'utf8');
        return true;
    }
    catch {
        return false;
    }
}
/** Read and validate an outcome file; missing or malformed yields undefined. */
export function readWizardResult(file) {
    if (!existsSync(file))
        return undefined;
    try {
        const parsed = JSON.parse(readFileSync(file, 'utf8'));
        if (parsed.status !== 'ok' && parsed.status !== 'cancelled' && parsed.status !== 'timeout' && parsed.status !== 'error') {
            return undefined;
        }
        return { ...parsed, status: parsed.status };
    }
    catch {
        return undefined;
    }
}
/** Best-effort cleanup of the result file and its directory. */
export function removeWizardResult(file) {
    try {
        rmSync(file, { force: true });
        rmSync(path.dirname(file), { recursive: true, force: true });
    }
    catch {
        // Leftover temp files are harmless; the OS sweeps its tmpdir.
    }
}
