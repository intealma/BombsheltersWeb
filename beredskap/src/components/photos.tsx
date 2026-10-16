import { useEffect, useState } from 'preact/hooks';
import { t } from '../i18n';
import { prepareImage } from '../lib/photos';
import { addPhoto, type DraftPhoto } from '../lib/drafts';

/** Thumbnail of a photo still on the device (blob) or already stored (signed URL). */
export function PhotoThumb({ blob, url, onRemove }: { blob?: Blob; url?: string; onRemove?: () => void }) {
  const [src, setSrc] = useState(url ?? '');
  useEffect(() => {
    if (!blob) {
      setSrc(url ?? '');
      return;
    }
    const u = URL.createObjectURL(blob);
    setSrc(u);
    return () => URL.revokeObjectURL(u);
  }, [blob, url]);
  return (
    <div class="thumb">
      {src && <img src={src} alt="" loading="lazy" />}
      {onRemove && (
        <button type="button" class="thumb-remove" aria-label={t('check.removePhoto')} onClick={onRemove}>
          ×
        </button>
      )}
    </div>
  );
}

/**
 * Camera / file button. Each picked image is shrunk and re-encoded on the
 * device (dropping EXIF), saved to the draft store, then handed to onAdded.
 */
export function AddPhotoButton(props: {
  draftId: string;
  itemKey: string;
  onAdded: (photo: DraftPhoto) => void;
  onError: (message: string) => void;
}) {
  async function onChange(input: HTMLInputElement) {
    const files = Array.from(input.files ?? []);
    input.value = '';
    for (const file of files) {
      try {
        const { blob, width, height } = await prepareImage(file);
        const photo: DraftPhoto = {
          id: crypto.randomUUID(),
          draftId: props.draftId,
          itemKey: props.itemKey,
          blob,
          width,
          height,
          uploaded: false,
          createdAt: new Date().toISOString(),
        };
        await addPhoto(photo);
        props.onAdded(photo);
      } catch {
        props.onError(t('check.photoFailed'));
      }
    }
  }

  return (
    <label class="add-photo">
      <input
        type="file"
        accept="image/*"
        capture="environment"
        multiple
        class="visually-hidden"
        onChange={(e) => onChange(e.currentTarget)}
      />
      <span aria-hidden="true">＋</span> {t('check.addPhoto')}
    </label>
  );
}
