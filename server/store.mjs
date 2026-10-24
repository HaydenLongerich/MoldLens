import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { HttpError } from './validation.mjs';

export async function createStore(dataDirectory, seeds = []) {
  await mkdir(dataDirectory, { recursive: true, mode: 0o700 });
  const filename = path.join(dataDirectory, 'requests.json');
  let state;
  const persist = async (records) => {
    const temporary = `${filename}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, JSON.stringify(records, null, 2) + '\n', { mode: 0o600 });
      await rename(temporary, filename);
    } catch (error) { await unlink(temporary).catch(() => {}); throw error; }
  };
  try {
    state = JSON.parse(await readFile(filename, 'utf8'));
    if (!Array.isArray(state)) throw new Error('The local request store must contain an array.');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    state = structuredClone(seeds);
    await persist(state);
  }
  let queue = Promise.resolve();
  const mutate = (callback) => {
    const task = queue.then(async () => {
      const next = structuredClone(state);
      const result = callback(next);
      await persist(next);
      state = next;
      return structuredClone(result);
    });
    queue = task.catch(() => {});
    return task;
  };
  const find = (records, id) => {
    const record = records.find((item) => item.id === id);
    if (!record) throw new HttpError(404, 'This inspection request could not be found.');
    return record;
  };
  return {
    async all() { await queue; return structuredClone(state); },
    async get(id) { await queue; return structuredClone(find(state, id)); },
    create(record) { return mutate((records) => { records.unshift(record); return record; }); },
    update(id, updates) { return mutate((records) => {
      const record = find(records, id);
      if ((updates.status ?? record.status) === 'Scheduled' && !(updates.scheduledAt ?? record.scheduledAt)) throw new HttpError(400, 'Please set an inspection date and time before marking the case as scheduled.');
      Object.assign(record, updates, { updatedAt: new Date().toISOString() });
      return record;
    }); },
    addNote(id, text) { return mutate((records) => {
      const record = find(records, id);
      const now = new Date().toISOString();
      record.notes.push({ id: randomUUID(), text, createdAt: now });
      record.updatedAt = now;
      return record;
    }); },
    filename,
  };
}
