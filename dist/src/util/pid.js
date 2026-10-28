import { closeSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
/** True when a process with this pid exists (EPERM means: exists, not ours). */
export function isProcessAlive(pid) {
    if (!Number.isInteger(pid) || pid <= 0)
        return false;
    try {
        process.kill(pid, 0);
        return true;
    }
    catch (error) {
        // EPERM means the process exists but belongs to another user.
        return error.code === 'EPERM';
    }
}
/**
 * Exclusive lock for one bridge instance. Held for the process lifetime and
 * released on shutdown; a lock whose recorded pid is dead is stolen, so a
 * crash cleans itself up on the next start.
 */
export function acquireInstanceLock(file, label = 'pi-lark') {
    mkdirSync(path.dirname(file), { recursive: true });
    for (let attempt = 0; attempt < 2; attempt += 1) {
        try {
            const fd = openSync(file, 'wx');
            try {
                writeFileSync(fd, `${process.pid}\n`, 'utf8');
            }
            finally {
                closeSync(fd);
            }
            return {
                file,
                release: () => {
                    try {
                        if (readFileSync(file, 'utf8').trim() === String(process.pid)) {
                            rmSync(file, { force: true });
                        }
                    }
                    catch {
                        // An abandoned lock was stolen meanwhile; nothing to do.
                    }
                },
            };
        }
        catch (error) {
            if (error.code !== 'EEXIST')
                throw error;
            let holder = Number.NaN;
            try {
                holder = Number.parseInt(readFileSync(file, 'utf8').trim(), 10);
            }
            catch {
                // Unreadable lock content: treat as stale.
            }
            if (Number.isInteger(holder) && holder > 0 && isProcessAlive(holder)) {
                throw new Error(`${label} 已在运行 (pid ${holder})；如确认已停止，请删除 ${file}`);
            }
            // The holder is gone: reclaim the abandoned lock and retry.
            try {
                rmSync(file, { force: true });
            }
            catch {
                // Raced with another starter; the next open() reports it.
            }
        }
    }
    throw new Error(`无法获取运行锁 ${file}`);
}
