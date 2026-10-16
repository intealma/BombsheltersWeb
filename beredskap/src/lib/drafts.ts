// Self-check and maintenance drafts live on the device (IndexedDB) until they
// are submitted, so a dropped connection in a basement never loses work.
// Photos are stored as already re-encoded JPEG blobs, without EXIF.

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

export interface MaintenanceDraft {
  id: string; // becomes the entry id, so a retried save is idempotent
  userId: string;
  shelterId: string;
  performedOn: string; // YYYY-MM-DD
  category: string;
  description: string;
  performedBy: string;
  updatedAt: string;
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
const DB_VERSION = 2;

type StoreName = 'drafts' | 'photos' | 'maintenance';

let dbPromise: Promise<IDBDatabase> | undefined;

function db(): Promise<IDBDatabase> {
  dbPromise ??= new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const d = req.result;
      // Version 1: self-check drafts and photos. Version 2: maintenance drafts.
      if (!d.objectStoreNames.contains('drafts')) {
        d.createObjectStore('drafts', { keyPath: 'id' }).createIndex('byUser', 'userId');
      }
      if (!d.objectStoreNames.contains('photos')) {
        d.createObjectStore('photos', { keyPath: 'id' }).createIndex('byDraft', 'draftId');
      }
      if (!d.objectStoreNames.contains('maintenance')) {
        d.createObjectStore('maintenance', { keyPath: 'id' }).createIndex('byUser', 'userId');
      }
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

async function store(name: StoreName, mode: IDBTransactionMode = 'readonly') {
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

/** Deletes a draft of either kind together with its photos. */
async function deleteWithPhotos(storeName: 'drafts' | 'maintenance', id: string): Promise<void> {
  const photos = await getPhotos(id);
  const tx = (await db()).transaction([storeName, 'photos'], 'readwrite');
  tx.objectStore(storeName).delete(id);
  for (const p of photos) tx.objectStore('photos').delete(p.id);
  await new Promise<void>((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

export async function deleteDraft(id: string): Promise<void> {
  await deleteWithPhotos('drafts', id);
}

export async function listMaintenanceDrafts(userId: string): Promise<MaintenanceDraft[]> {
  return request((await store('maintenance')).index('byUser').getAll(userId)) as Promise<MaintenanceDraft[]>;
}

export async function getMaintenanceDraft(userId: string, shelterId: string): Promise<MaintenanceDraft | undefined> {
  return (await listMaintenanceDrafts(userId)).find((d) => d.shelterId === shelterId);
}

export async function saveMaintenanceDraft(draft: MaintenanceDraft): Promise<void> {
  await request((await store('maintenance', 'readwrite')).put({ ...draft, updatedAt: new Date().toISOString() }));
}

export async function deleteMaintenanceDraft(id: string): Promise<void> {
  await deleteWithPhotos('maintenance', id);
}

/** Every unsent draft (self-checks and maintenance) the user has on this device. */
export async function countAllDrafts(userId: string): Promise<number> {
  return (await listDrafts(userId)).length + (await listMaintenanceDrafts(userId)).length;
}

export async function deleteAllDrafts(userId: string): Promise<void> {
  for (const d of await listDrafts(userId)) await deleteDraft(d.id);
  for (const d of await listMaintenanceDrafts(userId)) await deleteMaintenanceDraft(d.id);
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
