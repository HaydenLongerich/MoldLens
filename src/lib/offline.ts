import type { Attachment, Contractor, InspectionRequest, Priority, RequestStatus } from './types';

declare global {
  interface Window {
    __MOLDLENS_DEMO__?: { requests: InspectionRequest[]; contractors: Contractor[] };
  }
}

// Retain the original storage name so existing requests and uploads survive the rebrand.
const DB_NAME = 'moldbusters-offline-v1';
const ATTACHMENT_PREFIX = 'indexeddb:';
const MAX_FILES = 10;
const MAX_FILE_SIZE = 25 * 1024 * 1024;
const FILE_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif', 'video/mp4', 'video/quicktime', 'video/webm']);
const STATUS_VALUES: RequestStatus[] = ['New', 'In review', 'Scheduled', 'Completed', 'Referred'];
const PRIORITY_VALUES: Priority[] = ['Low', 'Medium', 'High'];
const PROPERTY_VALUES = ['House', 'Apartment', 'Commercial', 'Not specified'];
const AREA_VALUES = ['Basement', 'Bathroom', 'Attic', 'Kitchen', 'Living area', 'Other', 'Not specified'];
const SIZE_VALUES = ['Small — under 1 m²', 'Medium — 1 to 3 m²', 'Large — over 3 m²', 'Not sure'];
const DURATION_VALUES = ['In the last few days', '1–4 weeks ago', 'More than a month ago', 'Not sure'];
const SIGN_VALUES = ['Visible spots or discolouration', 'Musty smell', 'Water damage', 'Condensation', 'Not sure yet'];
const CONTACT_VALUES = ['Email', 'Phone call', 'Text message'];
const RELATIONSHIP_VALUES = ['Homeowner', 'Tenant', 'Property manager', 'Authorized representative', 'Not specified'];
const attachmentUrls = new Map<string, string>();
let databasePromise: Promise<IDBDatabase> | null = null;

interface StoredAttachment { id: string; blob: Blob; }

function bundledData() {
  const data = window.__MOLDLENS_DEMO__;
  if (!data || !Array.isArray(data.requests) || !Array.isArray(data.contractors)) {
    throw new Error('The offline preview data is missing. Please open the generated offline.html file.');
  }
  return data;
}

function storageError(error: unknown): Error {
  if (error instanceof DOMException && error.name === 'QuotaExceededError') {
    return new Error('Your browser storage is full. Free some browser storage or submit fewer or smaller attachments.');
  }
  if (error instanceof DOMException && ['SecurityError', 'UnknownError', 'InvalidStateError'].includes(error.name)) {
    return new Error('This browser cannot save local requests. Allow browser storage for this preview or use the local app server.');
  }
  return error instanceof Error ? error : new Error('Your local request could not be saved. Please try again.');
}

function result<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error('Local storage could not be read.'));
  });
}

async function transact<T>(db: IDBDatabase, stores: string[], mode: IDBTransactionMode, operation: (tx: IDBTransaction) => Promise<T> | T): Promise<T> {
  let tx: IDBTransaction;
  try { tx = db.transaction(stores, mode); } catch (error) { throw storageError(error); }
  const complete = new Promise<void>((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error || new Error('Local storage could not be updated.'));
    tx.onabort = () => reject(tx.error || new Error('The local update was cancelled.'));
  });
  // A failed request and its failed transaction can reject in the same event turn.
  void complete.catch(() => undefined);
  try {
    const value = await operation(tx);
    await complete;
    return value;
  } catch (error) {
    try { tx.abort(); } catch { /* A failed transaction may already be finished. */ }
    await complete.catch(() => undefined);
    throw storageError(error);
  }
}

async function database(): Promise<IDBDatabase> {
  if (databasePromise) return databasePromise;
  databasePromise = (async () => {
    if (typeof indexedDB === 'undefined') throw new Error('This browser does not support saving local requests. Use a browser with local storage support or run the local app server.');
    const seed = bundledData().requests;
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      let settled = false;
      const request = indexedDB.open(DB_NAME, 1);
      request.onupgradeneeded = () => {
        const connection = request.result;
        if (!connection.objectStoreNames.contains('requests')) connection.createObjectStore('requests', { keyPath: 'id' });
        if (!connection.objectStoreNames.contains('attachments')) connection.createObjectStore('attachments', { keyPath: 'id' });
      };
      request.onsuccess = () => {
        if (settled) { request.result.close(); return; }
        settled = true;
        resolve(request.result);
      };
      request.onerror = () => { settled = true; reject(request.error || new Error('Your browser could not open local storage.')); };
      request.onblocked = () => {
        settled = true;
        reject(new Error('Another preview tab is using an older workspace. Close it and try again.'));
      };
    });
    db.onversionchange = () => { db.close(); databasePromise = null; };
    try {
      // The write transaction serializes initialization across simultaneously opened tabs.
      await transact(db, ['requests'], 'readwrite', async tx => {
        const store = tx.objectStore('requests');
        if (await result(store.count()) === 0) {
          for (const item of seed) store.add(structuredClone(item));
        }
      });
    } catch (error) { db.close(); throw error; }
    return db;
  })().catch(error => { databasePromise = null; throw storageError(error); });
  return databasePromise;
}

function localAssetUrl(url: string): string {
  return url.startsWith('/sample-data/') ? new URL(url.slice(1), window.location.href).href : url;
}

async function hydrate(requests: InspectionRequest[], db: IDBDatabase): Promise<InspectionRequest[]> {
  const pendingIds = [...new Set(requests.flatMap(item => item.attachments)
    .filter(attachment => attachment.url.startsWith(ATTACHMENT_PREFIX))
    .map(attachment => attachment.url.slice(ATTACHMENT_PREFIX.length))
    .filter(id => !attachmentUrls.has(id)))];
  if (pendingIds.length > 0) {
    const blobs = await transact(db, ['attachments'], 'readonly', async tx => {
      const store = tx.objectStore('attachments');
      return Promise.all(pendingIds.map(id => result(store.get(id)) as Promise<StoredAttachment | undefined>));
    });
    blobs.forEach((entry, index) => {
      if (!entry?.blob) throw new Error('A saved attachment is unavailable. The browser storage may have been cleared.');
      const id = pendingIds[index];
      // Reuse object URLs across refreshes and case edits; the browser releases them on unload.
      if (!attachmentUrls.has(id)) attachmentUrls.set(id, URL.createObjectURL(entry.blob));
    });
  }
  return requests.map(item => ({
    ...item,
    attachments: item.attachments.map(attachment => ({
      ...attachment,
      url: attachment.url.startsWith(ATTACHMENT_PREFIX)
        ? attachmentUrls.get(attachment.url.slice(ATTACHMENT_PREFIX.length))!
        : localAssetUrl(attachment.url),
    })),
    ...(item.source ? { source: {
      ...item.source,
      reportUrl: localAssetUrl(item.source.reportUrl),
      storyUrl: localAssetUrl(item.source.storyUrl),
      timelineUrl: localAssetUrl(item.source.timelineUrl),
    } } : {}),
  }));
}

function textField(data: Record<string, unknown>, key: string, label: string, min = 1, max = 500): string {
  const value = data[key];
  if (typeof value !== 'string' || value.trim().length < min || value.trim().length > max || /[\u0000-\u0008\u000B\u000C\u000E-\u001F]/.test(value)) {
    throw new Error(`Please enter ${label}${min > 1 ? ` (${min}–${max} characters)` : ''}.`);
  }
  return value.trim();
}

function choiceField<T extends string>(data: Record<string, unknown>, key: string, values: readonly T[], label: string): T {
  const value = data[key];
  if (typeof value !== 'string' || !values.includes(value as T)) throw new Error(`Please choose a valid ${label}.`);
  return value as T;
}

function uniqueId(): string {
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  return Array.from(crypto.getRandomValues(new Uint8Array(16)), byte => byte.toString(16).padStart(2, '0')).join('');
}

function validateForm(form: FormData) {
  const encoded = form.get('data');
  let parsed: unknown;
  try {
    if (typeof encoded !== 'string') throw new Error();
    parsed = JSON.parse(encoded);
  } catch { throw new Error('The inspection details could not be read. Please try submitting again.'); }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('Please provide your inspection details.');
  const raw = parsed as Record<string, unknown>;
  const data: Record<string, unknown> = {
    ...raw,
    phone: raw.phone ?? '', address: raw.address ?? '',
    propertyType: raw.propertyType ?? 'Not specified', area: raw.area ?? 'Not specified',
    relationship: raw.relationship ?? 'Not specified', size: raw.size ?? 'Not sure',
    duration: raw.duration ?? 'Not sure', signs: raw.signs ?? [],
    contactPreference: raw.contactPreference ?? 'Email',
  };
  const name = textField(data, 'name', 'your full name', 2, 100);
  const email = textField(data, 'email', 'a valid email address', 3, 254);
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error('Please enter a valid email address.');
  const contactPreference = choiceField(data, 'contactPreference', CONTACT_VALUES, 'contact preference');
  const phone = textField(data, 'phone', 'a valid phone number', 0, 40);
  if (phone && (!/^[+\d\s().-]+$/.test(phone) || !/^\d{10,15}$/.test(phone.replace(/\D/g, '')))) throw new Error('Please enter a phone number with 10–15 digits.');
  if (contactPreference !== 'Email' && !phone) throw new Error('Please add a phone number for your preferred contact method.');
  const address = textField(data, 'address', 'the property address', 0, 300);
  const postal = textField(data, 'postalCode', 'a Canadian postal code', 6, 8).toUpperCase().replace(/[ -]/g, '');
  if (!/^[ABCEGHJ-NPRSTVXY]\d[ABCEGHJ-NPRSTV-Z]\d[ABCEGHJ-NPRSTV-Z]\d$/.test(postal)) throw new Error('Enter a Canadian postal code, like K1S 3W7.');
  const postalCode = `${postal.slice(0, 3)} ${postal.slice(3)}`;
  const description = textField(data, 'description', 'a description of the concern', 10, 5000);
  if (data.consent !== true) throw new Error('Your permission is needed to review this request.');
  if (!Array.isArray(data.signs) || data.signs.length > SIGN_VALUES.length || data.signs.some(sign => typeof sign !== 'string' || !SIGN_VALUES.includes(sign))) {
    throw new Error('Please choose the signs you have noticed from the available options.');
  }
  const rawFiles = form.getAll('files');
  if (rawFiles.length > MAX_FILES) throw new Error('You can upload up to 10 files.');
  const files = rawFiles.map(file => {
    if (!(file instanceof File) || !FILE_TYPES.has(file.type)) throw new Error('Please upload JPG, PNG, WebP, HEIC, MP4, MOV, or WebM files.');
    if (file.size === 0 || file.size > MAX_FILE_SIZE) throw new Error(`${file.name}: files must be larger than 0 bytes and no larger than 25 MB.`);
    return file;
  });
  return {
    files,
    fields: {
      name, email, phone, address, postalCode, description,
      propertyType: choiceField(data, 'propertyType', PROPERTY_VALUES, 'property type'),
      area: choiceField(data, 'area', AREA_VALUES, 'area of concern'),
      size: choiceField(data, 'size', SIZE_VALUES, 'affected area size'),
      duration: choiceField(data, 'duration', DURATION_VALUES, 'timeframe'),
      contactPreference,
      relationship: choiceField(data, 'relationship', RELATIONSHIP_VALUES, 'relationship to the property'),
      signs: [...new Set(data.signs as string[])], consent: true,
    },
  };
}

async function validateMedia(files: File[]): Promise<void> {
  await Promise.all(files.map(async file => {
    const bytes = new Uint8Array(await file.slice(0, 4100).arrayBuffer());
    const ascii = (start: number, end: number) => String.fromCharCode(...bytes.slice(start, end));
    const startsWith = (signature: number[]) => signature.every((byte, index) => bytes[index] === byte);
    let detected: string | null = null;
    if (bytes.length >= 16 && startsWith([137, 80, 78, 71, 13, 10, 26, 10]) && ascii(12, 16) === 'IHDR') detected = 'image/png';
    else if (bytes.length >= 4 && startsWith([0xff, 0xd8, 0xff])) detected = 'image/jpeg';
    else if (bytes.length >= 16 && ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WEBP') detected = 'image/webp';
    else if (bytes.length >= 16 && ascii(4, 8) === 'ftyp') {
      const major = ascii(8, 12);
      if (['heic', 'heix', 'hevc', 'hevx', 'heim', 'heis', 'hevm', 'hevs'].includes(major)) detected = 'image/heic';
      else if (['mif1', 'msf1'].includes(major)) detected = 'image/heif';
      else if (major === 'qt  ') detected = 'video/quicktime';
      else if (['isom', 'iso2', 'iso3', 'iso4', 'iso5', 'iso6', 'mp41', 'mp42', 'avc1', 'M4V ', 'M4VH', 'M4VP', 'MSNV', 'dash', 'cmfc', 'cmfs'].includes(major)) detected = 'video/mp4';
    } else if (bytes.length >= 12 && startsWith([0x1a, 0x45, 0xdf, 0xa3]) && ascii(0, bytes.length).includes('webm')) detected = 'video/webm';
    const heifPair = detected && ['image/heic', 'image/heif'].includes(detected) && ['image/heic', 'image/heif'].includes(file.type);
    if (!detected || (!heifPair && detected !== file.type)) throw new Error(`${file.name}: the file does not match its media type. Please upload an original photo or video.`);
  }));
}

export const offlineApi = {
  async getRequests(): Promise<InspectionRequest[]> {
    const db = await database();
    const items = await transact(db, ['requests'], 'readonly', tx => result(tx.objectStore('requests').getAll()) as Promise<InspectionRequest[]>);
    items.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    return hydrate(items, db);
  },

  async createRequest(form: FormData): Promise<InspectionRequest> {
    const { fields, files } = validateForm(form);
    await validateMedia(files);
    const now = new Date().toISOString();
    const attachments: Attachment[] = files.map(file => {
      const id = uniqueId();
      return { id, name: file.name.replace(/[\\/\u0000-\u001f]/g, '_').slice(0, 240), type: file.type, size: file.size, url: `${ATTACHMENT_PREFIX}${id}` };
    });
    const item: InspectionRequest = {
      ...fields, id: `ML-${Date.now().toString(36).toUpperCase()}-${uniqueId().slice(0, 6).toUpperCase()}`,
      status: 'New', priority: 'Medium', createdAt: now, updatedAt: now,
      assignee: '', scheduledAt: '', attachments, notes: [], isDemo: false,
    };
    const db = await database();
    await transact(db, ['requests', 'attachments'], 'readwrite', tx => {
      const attachmentStore = tx.objectStore('attachments');
      files.forEach((file, index) => attachmentStore.add({ id: attachments[index].id, blob: file } satisfies StoredAttachment));
      tx.objectStore('requests').add(item);
    });
    return (await hydrate([item], db))[0];
  },

  async updateRequest(id: string, updates: Partial<InspectionRequest>): Promise<InspectionRequest> {
    if (!updates || typeof updates !== 'object' || Array.isArray(updates)) throw new Error('Please provide valid case updates.');
    const allowed = ['status', 'priority', 'assignee', 'scheduledAt'];
    if (!Object.keys(updates).length || Object.keys(updates).some(key => !allowed.includes(key))) throw new Error('Only status, priority, assignment, and inspection date can be updated.');
    const changes: Partial<InspectionRequest> = {};
    if ('status' in updates) changes.status = choiceField(updates, 'status', STATUS_VALUES, 'case status');
    if ('priority' in updates) changes.priority = choiceField(updates, 'priority', PRIORITY_VALUES, 'priority');
    if ('assignee' in updates) {
      changes.assignee = textField(updates, 'assignee', 'a team member name', 0, 100);
    }
    if ('scheduledAt' in updates) {
      if (typeof updates.scheduledAt !== 'string' || (updates.scheduledAt !== '' && (updates.scheduledAt.length > 40 || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(updates.scheduledAt) || !Number.isFinite(Date.parse(updates.scheduledAt))))) throw new Error('Please enter a valid inspection date and time.');
      changes.scheduledAt = updates.scheduledAt ? new Date(updates.scheduledAt).toISOString() : '';
    }
    const db = await database();
    const item = await transact(db, ['requests'], 'readwrite', async tx => {
      const store = tx.objectStore('requests');
      const existing = await result(store.get(id)) as InspectionRequest | undefined;
      if (!existing) throw new Error('This inspection request could not be found.');
      const updated: InspectionRequest = { ...existing, ...changes, updatedAt: new Date().toISOString() };
      if (updated.status === 'Scheduled' && !updated.scheduledAt) {
        throw new Error('Please set an inspection date and time before marking the case as scheduled.');
      }
      store.put(updated);
      return updated;
    });
    return (await hydrate([item], db))[0];
  },

  async addNote(id: string, text: string): Promise<InspectionRequest> {
    const note = textField({ text }, 'text', 'a note', 1, 3000);
    const db = await database();
    const item = await transact(db, ['requests'], 'readwrite', async tx => {
      const store = tx.objectStore('requests');
      const existing = await result(store.get(id)) as InspectionRequest | undefined;
      if (!existing) throw new Error('This inspection request could not be found.');
      const now = new Date().toISOString();
      const updated: InspectionRequest = {
        ...existing, updatedAt: now,
        notes: [...existing.notes, { id: uniqueId(), text: note, createdAt: now }],
      };
      store.put(updated);
      return updated;
    });
    return (await hydrate([item], db))[0];
  },

  async getContractors(): Promise<Contractor[]> {
    return structuredClone(bundledData().contractors);
  },
};
