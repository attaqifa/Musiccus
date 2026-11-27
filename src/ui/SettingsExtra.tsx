import { useEffect, useState } from 'react';
import { gpuInfo, isWindows, type GpuInfo } from '../lib/gpu';
import { requestPersistence, storageInfo } from '../lib/storage';
import { clearStemCache, deleteModel, refreshModelStatus, stemCacheSize } from '../stems/manager';
import { useStems } from '../stems/store';
import { ConfirmButton } from './ConfirmButton';

const mb = (b: number) => `${Math.round(b / 1e6).toLocaleString('id-ID')} MB`;

/**
 * Which GPU draws the visuals and runs the stem AI. On a dual-GPU laptop
 * Windows hands browsers the integrated one, so say how to switch.
 */
export function GpuReadout() {
  const [info, setInfo] = useState<GpuInfo | null>(null);
  useEffect(() => {
    void gpuInfo().then(setInfo);
  }, []);
  if (!info) return <p className="drawer-note">Memeriksa GPU…</p>;
  return (
    <div className="gpu-readout">
      <p className="drawer-note">
        Visual: <strong>{info.visual ?? 'tidak diketahui (disembunyikan browser)'}</strong>
        <br />
        Stem AI: <strong>{info.ai ?? 'WebGPU tidak tersedia di browser ini'}</strong>
      </p>
      {info.integrated && isWindows() && (
        <p className="drawer-note gpu-tip">
          Ini GPU terintegrasi. Kalau laptop Anda juga punya GPU NVIDIA atau AMD, Windows tetap menjalankan browser di GPU ini supaya
          hemat baterai. Untuk visual yang lebih mulus dan stem AI yang lebih cepat: buka Settings Windows → System → Display → Graphics,
          pilih browser ini, klik Options → High performance, lalu tutup dan buka lagi browsernya.
        </p>
      )}
    </div>
  );
}

export function StemStorage() {
  const modelCached = useStems((s) => s.modelCached);
  const [cache, setCache] = useState<number | null>(null);
  const [info, setInfo] = useState<Awaited<ReturnType<typeof storageInfo>>>(null);
  useEffect(() => {
    void refreshModelStatus();
    void stemCacheSize().then(setCache);
    void storageInfo().then(setInfo);
  }, []);
  const protect = async () => {
    await requestPersistence();
    setInfo(await storageInfo());
  };
  return (
    <div className="stem-storage">
      <p className="drawer-note">
        Model AI: {modelCached ? 'tersimpan (126 MB)' : 'belum diunduh'}. Stem hasil AI: {cache === null ? '…' : mb(cache)} di penyimpanan browser, maksimal 2,5 GB
        (lagu terlama dihapus lebih dulu).
      </p>
      {info && (
        <p className="drawer-note">
          Musiccus memakai {mb(info.usage)} dari kuota {mb(info.quota)}.{' '}
          {info.persisted
            ? 'Data terlindungi: browser tidak akan menghapusnya saat disk menipis.'
            : 'Data belum terlindungi: browser boleh menghapusnya saat disk menipis.'}
        </p>
      )}
      <div className="stem-storage-actions">
        {info && !info.persisted && (
          <button className="btn small" onClick={() => void protect()}>
            Lindungi data
          </button>
        )}
        <ConfirmButton
          className="btn small"
          disabled={!modelCached}
          label="Hapus model AI"
          confirm="Ya, hapus 126 MB"
          note="Pemisahan AI berikutnya harus mengunduh model ini lagi."
          onConfirm={() => void deleteModel()}
        />
        <ConfirmButton
          className="btn small"
          disabled={!cache}
          label="Hapus stem tersimpan"
          confirm={`Ya, hapus ${cache ? mb(cache) : ''}`}
          note="Lagu yang sudah dipisahkan dengan AI harus diproses ulang."
          onConfirm={() => void clearStemCache().then(() => stemCacheSize().then(setCache))}
        />
      </div>
    </div>
  );
}
