"use client";

import { Camera, RefreshCw, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useI18n } from "../../i18n/I18nProvider";

/**
 * Prise de photo à la webcam (ordinateur). Sur téléphone, PhotoUploader ouvre plutôt
 * l'appareil photo du téléphone, qui donne de meilleures photos.
 */
export function CameraDialog({ onCapture, onClose }: { onCapture: (file: File) => void; onClose: () => void }) {
  const { photos: t, common } = useI18n().t;
  const dialog = useRef<HTMLDialogElement>(null);
  const video = useRef<HTMLVideoElement>(null);
  const [facing, setFacing] = useState<"environment" | "user">("environment");
  const [cameras, setCameras] = useState(0);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    dialog.current?.showModal();
  }, []);

  useEffect(() => {
    let stream: MediaStream | null = null;
    let cancelled = false;
    setReady(false);
    setError(null);
    navigator.mediaDevices
      .getUserMedia({ video: { facingMode: facing, width: { ideal: 1920 }, height: { ideal: 1920 } }, audio: false })
      .then(async (s) => {
        if (cancelled) return s.getTracks().forEach((track) => track.stop());
        stream = s;
        if (video.current) video.current.srcObject = s;
        const devices = await navigator.mediaDevices.enumerateDevices();
        setCameras(devices.filter((d) => d.kind === "videoinput").length);
      })
      .catch((e: unknown) => {
        const name = e instanceof DOMException ? e.name : "";
        setError(name === "NotAllowedError" || name === "SecurityError" ? t.cameraDenied : t.cameraUnavailable);
      });
    return () => {
      cancelled = true;
      stream?.getTracks().forEach((track) => track.stop());
    };
  }, [facing, t]);

  function capture() {
    const v = video.current;
    if (!v || !v.videoWidth) return;
    const canvas = document.createElement("canvas");
    canvas.width = v.videoWidth;
    canvas.height = v.videoHeight;
    canvas.getContext("2d")!.drawImage(v, 0, 0);
    canvas.toBlob(
      (blob) => {
        if (!blob) return;
        onCapture(new File([blob], `photo-${Date.now()}.jpg`, { type: "image/jpeg" }));
        onClose();
      },
      "image/jpeg",
      0.92,
    );
  }

  return (
    <dialog ref={dialog} className="camera" onClose={onClose} aria-label={t.cameraTitle}>
      <div className="camera-head">
        <strong>{t.cameraTitle}</strong>
        <button type="button" className="icon-btn icon-btn--light" onClick={onClose} aria-label={common.cancel}>
          <X size={18} aria-hidden />
        </button>
      </div>
      {error ? (
        <p className="field-error camera-error">{error}</p>
      ) : (
        <video ref={video} className="camera-video" autoPlay playsInline muted onLoadedMetadata={() => setReady(true)} />
      )}
      <div className="camera-actions">
        {cameras > 1 && !error && (
          <button type="button" className="btn btn--secondary" onClick={() => setFacing((f) => (f === "user" ? "environment" : "user"))}>
            <RefreshCw size={16} aria-hidden /> {t.switchCamera}
          </button>
        )}
        <button type="button" className="btn" onClick={capture} disabled={!ready || !!error}>
          <Camera size={18} aria-hidden /> {t.capture}
        </button>
      </div>
    </dialog>
  );
}
