import React, { useCallback, useEffect, useState } from 'react';
import { Check, Disc3, Globe, Loader2, Search, X } from 'lucide-react';
import {
  OnlineCoverCandidate,
  searchOnlineCovers,
} from '../../services/coverSearchService';
import { TrackColorPalette, TrackMetadata } from '../../types/music';

interface CoverSearchModalProps {
  open: boolean;
  track: TrackMetadata | null;
  palette: TrackColorPalette;
  onClose: () => void;
  onSelectCoverUrl: (coverUrl: string) => Promise<void>;
}

export const CoverSearchModal: React.FC<CoverSearchModalProps> = ({
  open,
  track,
  palette,
  onClose,
  onSelectCoverUrl,
}) => {
  const [titleQuery, setTitleQuery] = useState('');
  const [artistQuery, setArtistQuery] = useState('');
  const [loading, setLoading] = useState(false);
  const [applyingId, setApplyingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [candidates, setCandidates] = useState<OnlineCoverCandidate[]>([]);

  const runSearch = useCallback(async (title: string, artist: string) => {
    if (!title.trim() && !artist.trim()) return;
    setLoading(true);
    setError(null);
    try {
      const list = await searchOnlineCovers(title, artist);
      setCandidates(list);
      if (list.length === 0) {
        setError('未搜索到匹配的专辑封面，请尝试简化歌名或更换关键词。');
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : '在线封面搜索失败');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (open && track) {
      const cleanTitle = track.title.replace(/\(.*\)|\[.*\]/g, '').trim();
      const cleanArtist =
        track.artist === '未知艺术家' || track.artist === 'Unknown Artist'
          ? ''
          : track.artist;
      setTitleQuery(cleanTitle);
      setArtistQuery(cleanArtist);
      setCandidates([]);
      setError(null);
      setApplyingId(null);
      if (cleanTitle || cleanArtist) {
        void runSearch(cleanTitle, cleanArtist);
      }
    }
  }, [open, track, runSearch]);

  if (!open || !track) return null;

  const handleApply = async (item: OnlineCoverCandidate) => {
    setApplyingId(item.id);
    setError(null);
    try {
      await onSelectCoverUrl(item.coverUrl);
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : '下载并应用封面失败');
    } finally {
      setApplyingId(null);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-3 sm:p-4">
      <div
        onClick={onClose}
        className="absolute inset-0 bg-black/65 backdrop-blur-sm"
      />
      <div className="relative z-10 w-full max-w-2xl max-h-[88vh] bg-[#1b0711]/95 backdrop-blur-2xl border border-white/14 rounded-3xl flex flex-col shadow-2xl overflow-hidden">
        <div className="flex items-center justify-between px-6 py-4 border-b border-white/10 shrink-0">
          <div className="flex items-center gap-2.5 min-w-0">
            <Globe className="w-4 h-4 text-rose-300 shrink-0" />
            <h3 className="text-base font-semibold text-white truncate">
              在线搜索专辑封面 · {track.title}
            </h3>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="p-2 rounded-lg text-white/65 hover:text-white hover:bg-white/10 transition-colors cursor-pointer"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        <form
          onSubmit={(e) => {
            e.preventDefault();
            void runSearch(titleQuery, artistQuery);
          }}
          className="p-4 sm:p-5 border-b border-white/10 space-y-3 shrink-0"
        >
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <label className="block text-xs text-white/60 mb-1">歌曲 / 专辑名</label>
              <input
                type="text"
                value={titleQuery}
                onChange={(e) => setTitleQuery(e.target.value)}
                placeholder="输入歌名或专辑名..."
                className="w-full px-3.5 py-2 rounded-xl bg-white/8 border border-white/12 text-sm text-white placeholder-white/35 focus:outline-none focus:border-white/35"
              />
            </div>
            <div>
              <label className="block text-xs text-white/60 mb-1">艺术家 (可选)</label>
              <input
                type="text"
                value={artistQuery}
                onChange={(e) => setArtistQuery(e.target.value)}
                placeholder="输入歌手名..."
                className="w-full px-3.5 py-2 rounded-xl bg-white/8 border border-white/12 text-sm text-white placeholder-white/35 focus:outline-none focus:border-white/35"
              />
            </div>
          </div>

          <div className="flex items-center justify-between gap-3">
            <span className="text-[11px] text-white/50">
              仅在您主动搜索并选择后应用，不会误识别文件夹图片
            </span>
            <button
              type="submit"
              disabled={loading || applyingId !== null}
              className="px-4 py-2 rounded-xl text-xs font-medium text-white flex items-center gap-1.5 cursor-pointer disabled:opacity-50"
              style={{
                background: `linear-gradient(135deg, ${palette.primary}, ${palette.secondary})`,
              }}
            >
              {loading ? (
                <Loader2 className="w-3.5 h-3.5 animate-spin" />
              ) : (
                <Search className="w-3.5 h-3.5" />
              )}
              <span>搜索封面</span>
            </button>
          </div>
        </form>

        <div className="flex-1 overflow-y-auto lumina-scroll p-4 sm:p-5 space-y-3 min-h-[220px]">
          {error && (
            <p className="text-xs text-rose-300 text-center py-3 px-3 bg-rose-500/10 border border-rose-500/20 rounded-2xl">
              {error}
            </p>
          )}

          {loading ? (
            <div className="py-16 flex flex-col items-center justify-center gap-2 text-xs text-white/60">
              <Loader2 className="w-6 h-6 animate-spin text-rose-300" />
              <span>正在检索在线高清专辑封面…</span>
            </div>
          ) : candidates.length === 0 && !error ? (
            <div className="py-14 flex flex-col items-center justify-center gap-2 text-xs text-white/45">
              <Disc3 className="w-8 h-8 text-white/30" />
              <span>输入歌名或歌手点击“搜索封面”</span>
            </div>
          ) : (
            <div className="grid grid-cols-2 sm:grid-cols-3 gap-3.5">
              {candidates.map((item) => {
                const isApplying = applyingId === item.id;
                return (
                  <button
                    key={item.id}
                    type="button"
                    disabled={applyingId !== null}
                    onClick={() => void handleApply(item)}
                    className="group text-left rounded-2xl bg-white/[0.05] hover:bg-white/[0.1] border border-white/10 p-2.5 transition-all cursor-pointer disabled:opacity-60 flex flex-col gap-2"
                  >
                    <div className="relative aspect-square w-full rounded-xl overflow-hidden bg-black/40">
                      <img
                        src={item.thumbnailUrl || item.coverUrl}
                        alt={item.album || item.title}
                        referrerPolicy="no-referrer"
                        className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-300"
                      />
                      <div
                        className={`absolute inset-0 bg-black/55 flex items-center justify-center transition-opacity ${
                          isApplying
                            ? 'opacity-100'
                            : 'opacity-0 group-hover:opacity-100'
                        }`}
                      >
                        {isApplying ? (
                          <Loader2 className="w-5 h-5 animate-spin text-white" />
                        ) : (
                          <span className="px-2.5 py-1 rounded-lg bg-white/15 border border-white/25 text-[11px] font-medium text-white flex items-center gap-1">
                            <Check className="w-3 h-3" />
                            设为封面
                          </span>
                        )}
                      </div>
                    </div>
                    <div className="min-w-0">
                      <p className="text-xs font-medium text-white truncate">
                        {item.album || item.title}
                      </p>
                      <p className="text-[11px] text-white/55 truncate mt-0.5">
                        {item.artist} · {item.source}
                      </p>
                    </div>
                  </button>
                );
              })}
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
