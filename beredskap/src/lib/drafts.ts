// Self-check drafts live on the device (IndexedDB) until they are submitted,
// so a dropped connection in a basement never loses work. Photos are stored
// as already re-encoded JPEG blobs, without EXIF.

import type { Template } from './checklist';

export type Status = 'ok' | 'brist' | 'ej_tillampligt';

export interface DraftAnswer {
  status?: Status;
  comment: string;
}

export interface Draft {
  id: string; // becomes the self-check id, so a retried submit is idempotent
  userId: string;
  shelterId: string;
  shelterAddress: string;
  kommun: string;
  template: Template;
  inspectorName: string;
  startedAt: string;
  updatedAt: string;
  step: number; // 0 intro, 1..n items, n + 1 summary
  answers: Record<string, DraftAnswer>; // by checklist item id
}

export interface DraftPhoto {
  id: string;
  draftId: string;
  itemKey: string;
  blob: Blob;
  width: number;
  height: number;
  uploaded: boolean;
  createdAt: string;
}

const DB_NAME = 'beredskap';
const DB_VERSION = 1;

let dbPromise: Promise<IDBDatabase> | undefined;

function db(): Promise<IDBDatabase> {
  dbPromise ??= new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const d = req.result;
      const drafts = d.createObjectStore('drafts', { keyPath: 'id' });
      drafts.createIndex('byUser', 'userId');
      const photos = d.createObjectStore('photos', { keyPath: 'id' });
      photos.createIndex('byDraft', 'draftId');
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

function request<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function store(name: 'drafts' | 'photos', mode: IDBTransactionMode = 'readonly') {
  return (await db()).transaction(name, mode).objectStore(name);
}

export async function listDrafts(userId: string): Promise<Draft[]> {
  return request((await store('drafts')).index('byUser').getAll(userId)) as Promise<Draft[]>;
}

export async function getDraftForShelter(userId: string, shelterId: string): Promise<Draft | undefined> {
  return (await listDrafts(userId)).find((d) => d.shelterId === shelterId);
}

export async function saveDraft(draft: Draft): Promise<void> {
  await request((await store('drafts', 'readwrite')).put({ ...draft, updatedAt: new Date().toISOString() }));
}

export async function deleteDraft(id: string): Promise<void> {
  const photos = await getPhotos(id);
  const tx = (await db()).transaction(['drafts', 'photos'], 'readwrite');
  tx.objectStore('drafts').delete(id);
  for (const p of photos) tx.objectStore('photos').delete(p.id);
  await new Promise<void>((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

export async function deleteAllDrafts(userId: string): Promise<void> {
  for (const d of await listDrafts(userId)) await deleteDraft(d.id);
}

export async function getPhotos(draftId: string): Promise<DraftPhoto[]> {
  const photos = (await request((await store('photos')).index('byDraft').getAll(draftId))) as DraftPhoto[];
  return photos.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

export async function addPhoto(photo: DraftPhoto): Promise<void> {
  await request((await store('photos', 'readwrite')).put(photo));
}

export async function deletePhoto(id: string): Promise<void> {
  await request((await store('photos', 'readwrite')).delete(id));
}

export async function markPhotoUploaded(photo: DraftPhoto): Promise<void> {
  await request((await store('photos', 'readwrite')).put({ ...photo, uploaded: true }));
}
