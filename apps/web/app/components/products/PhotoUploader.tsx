"use client";

import { ArrowLeft, ArrowRight, ImagePlus, Loader2, Star, X } from "lucide-react";
import { useRef, useState, type DragEvent } from "react";
import { useI18n } from "../../i18n/I18nProvider";
import { api, type Photo } from "../../lib/api";

export const MAX_PHOTOS = 12;
const ACCEPT = "image/jpeg,image/png,image/webp";

/**
 * Photos du produit (US4 : 1 à 12). La première est la photo principale.
 * Chaque fichier est envoyé dès qu'il est choisi ; l'ordre se règle avec les flèches.
 */
export function PhotoUploader({ photos, onChange }: { photos: Photo[]; onChange: (photos: Photo[]) => void }) {
  const t = useI18n().t.photos;
  const input = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const remaining = MAX_PHOTOS - photos.length - uploading;

  async function addFiles(files: FileList | File[]) {
    setError(null);
    const list = Array.from(files);
    if (list.length > remaining) setError(t.tooMany(MAX_PHOTOS, list.length - Math.max(remaining, 0)));
    const accepted = list.slice(0, Math.max(remaining, 0));
    if (accepted.length === 0) return;

    setUploading((n) => n + accepted.length);
    const results = await Promise.all(
      accepted.map(async (file) => {
        const form = new FormData();
        form.append("file", file);
        const res = await api<Photo>("/photos", { method: "POST", body: form });
        setUploading((n) => n - 1);
        if (!res.ok) setError(`${file.name} : ${res.message}`);
        return res.ok ? res.data : null;
      }),
    );
    onChange([...photos, ...results.filter((p): p is Photo => p !== null)]);
  }

  function move(index: number, delta: number) {
    const next = [...photos];
    const [item] = next.splice(index, 1);
    next.splice(index + delta, 0, item!);
    onChange(next);
  }

  function onDrop(e: DragEvent) {
    e.preventDefault();
    setDragOver(false);
    if (e.dataTransfer.files.length) void addFiles(e.dataTransfer.files);
  }

  return (
    <div className="photos">
      <div className="photos-grid">
        {photos.map((photo, i) => (
          <figure key={photo.id} className={`photo${i === 0 ? " photo--main" : ""}`}>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={`/api${photo.url}`} alt={t.alt(i + 1)} />
            {i === 0 && (
              <span className="photo-badge">
                <Star size={12} aria-hidden /> {t.main}
              </span>
            )}
            <div className="photo-actions">
              <button type="button" className="photo-btn" onClick={() => move(i, -1)} disabled={i === 0} aria-label={t.moveBack(i + 1)}>
                <ArrowLeft size={14} />
              </button>
              <button
                type="button"
                className="photo-btn"
                onClick={() => move(i, 1)}
                disabled={i === photos.length - 1}
                aria-label={t.moveForward(i + 1)}
              >
                <ArrowRight size={14} />
              </button>
              <button
                type="button"
                className="photo-btn photo-btn--danger"
                onClick={() => onChange(photos.filter((p) => p.id !== photo.id))}
                aria-label={t.remove(i + 1)}
              >
                <X size={14} />
              </button>
            </div>
          </figure>
        ))}
        {Array.from({ length: uploading }, (_, i) => (
          <div key={`up-${i}`} className="photo photo--loading" aria-label={t.uploading}>
            <Loader2 size={22} className="spin" aria-hidden />
          </div>
        ))}
        {remaining > 0 && (
          <button
            type="button"
            className={`photo-drop${dragOver ? " is-over" : ""}`}
            onClick={() => input.current?.click()}
            onDragOver={(e) => {
              e.preventDefault();
              setDragOver(true);
            }}
            onDragLeave={() => setDragOver(false)}
            onDrop={onDrop}
          >
            <ImagePlus size={24} aria-hidden />
            <span>{t.add}</span>
            <small>{t.formats}</small>
          </button>
        )}
      </div>
      <input
        ref={input}
        type="file"
        accept={ACCEPT}
        multiple
        hidden
        onChange={(e) => {
          if (e.target.files) void addFiles(e.target.files);
          e.target.value = "";
        }}
      />
      <p className="field-hint">
        {t.counter(photos.length, MAX_PHOTOS)}
      </p>
      {error && <p className="field-error">{error}</p>}
    </div>
  );
}
