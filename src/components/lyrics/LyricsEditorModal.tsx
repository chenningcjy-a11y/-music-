import React, { useEffect, useState } from 'react';
import { Clock, RotateCcw, Save, Undo2, X } from 'lucide-react';
import { LyricPairRecord, TrackColorPalette, TrackMetadata } from '../../types/music';
import { buildLyricPairsFromRaw, formatLrcTimestamp } from '../../utils/lrcParser';

interface LyricsEditorModalProps {
  open: boolean;
  track: TrackMetadata | null;
  currentTime: number;
  palette: TrackColorPalette;
  onClose: () => void;
  onSave: (rawLrc: string) => void | Promise<void>;
  onSavePairs?: (pairs: LyricPairRecord[]) => void | Promise<void>;
  onRestoreOriginal?: () => void | Promise<void>;
  onRestoreInitialTranslation?: () => void | Promise<void>;
}

export const LyricsEditorModal: React.FC<LyricsEditorModalProps> = ({
  open,
  track,
  currentTime,
  palette,
  onClose,
  onSave,
  onSavePairs,
  onRestoreOriginal,
  onRestoreInitialTranslation,
}) => {
  const [tab, setTab] = useState<'pairs' | 'raw'>('pairs');
  const [draft, setDraft] = useState('');
  const [pairsDraft, setPairsDraft] = useState<LyricPairRecord[]>([]);

  useEffect(() => {
    if (open && track) {
      setDraft(track.lyricsRaw || track.originalLyricsRaw || '');
      const initialPairs =
        track.lyricPairs && track.lyricPairs.length > 0
          ? track.lyricPairs
          : buildLyricPairsFromRaw(track.lyricsRaw || track.originalLyricsRaw);
      setPairsDraft(initialPairs.map((p) => ({ ...p })));
      setTab(initialPairs.length > 0 && onSavePairs ? 'pairs' : 'raw');
    }
  }, [open, track, onSavePairs]);

  if (!open || !track) return null;

  const insertTimestampAtTopOrEnd = () => {
    const tag = formatLrcTimestamp(currentTime);
    setDraft((prev) => (prev ? `${prev}\n${tag} ` : `${tag} `));
  };

  const hasInitialBackup = Boolean(
    track.translationMeta?.initialAiTranslatedRaw ||
      track.translationMeta?.initialAiBilingualRaw
  );

  const handleSaveAction = async () => {
    if (tab === 'pairs' && onSavePairs) {
      await onSavePairs(pairsDraft);
    } else {
      await onSave(draft);
    }
    onClose();
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div
        onClick={onClose}
        className="absolute inset-0 bg-black/65 backdrop-blur-sm"
      />
      <div className="relative z-10 w-full max-w-3xl max-h-[88vh] bg-[#1b0711]/95 backdrop-blur-2xl border border-white/14 rounded-3xl flex flex-col shadow-2xl overflow-hidden">
        <div className="flex items-center justify-between px-6 py-4 border-b border-white/10 shrink-0">
          <div className="min-w-0">
            <h3 className="text-base font-semibold text-white truncate">
              歌词与译文编辑器 · {track.title}
            </h3>
            <p className="text-xs text-white/55 mt-0.5">
              原文与翻译独立编辑归档，修改译文绝不破坏原歌词与时间轴
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="p-2 rounded-lg text-white/65 hover:text-white hover:bg-white/10 transition-colors cursor-pointer"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Mode Switcher + Restore Controls */}
        <div className="px-5 pt-3.5 flex flex-wrap items-center justify-between gap-2 shrink-0">
          <div className="flex items-center gap-1 bg-white/[0.06] border border-white/10 p-1 rounded-xl">
            {onSavePairs && (
              <button
                type="button"
                onClick={() => setTab('pairs')}
                className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-colors cursor-pointer ${
                  tab === 'pairs'
                    ? 'bg-white/16 text-white'
                    : 'text-white/60 hover:text-white'
                }`}
              >
                逐句对照编辑 ({pairsDraft.length})
              </button>
            )}
            <button
              type="button"
              onClick={() => setTab('raw')}
              className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-colors cursor-pointer ${
                tab === 'raw'
                  ? 'bg-white/16 text-white'
                  : 'text-white/60 hover:text-white'
              }`}
            >
              LRC 源码编辑
            </button>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            {onRestoreOriginal && (
              <button
                type="button"
                onClick={async () => {
                  await onRestoreOriginal();
                  onClose();
                }}
                className="px-2.5 py-1.5 rounded-lg bg-white/8 hover:bg-white/14 border border-white/10 text-[11px] text-white/80 flex items-center gap-1 cursor-pointer"
              >
                <RotateCcw className="w-3 h-3" />
                <span>仅保留原文</span>
              </button>
            )}
            {onRestoreInitialTranslation && hasInitialBackup && (
              <button
                type="button"
                onClick={async () => {
                  await onRestoreInitialTranslation();
                  onClose();
                }}
                className="px-2.5 py-1.5 rounded-lg bg-rose-500/15 hover:bg-rose-500/25 border border-rose-400/25 text-[11px] text-rose-200 flex items-center gap-1 cursor-pointer"
              >
                <Undo2 className="w-3 h-3" />
                <span>恢复最初 AI 翻译</span>
              </button>
            )}
          </div>
        </div>

        {tab === 'pairs' ? (
          <div className="p-5 flex-1 overflow-y-auto lumina-scroll space-y-2.5 min-h-[260px]">
            {pairsDraft.length === 0 ? (
              <div className="py-12 text-center text-xs text-white/50">
                当前尚无歌词行，请切换至「LRC 源码编辑」输入歌词。
              </div>
            ) : (
              pairsDraft.map((pair, idx) => (
                <div
                  key={`${pair.idx}-${idx}`}
                  className="p-3 rounded-2xl bg-black/30 border border-white/10 space-y-2"
                >
                  <div className="flex items-center justify-between text-[11px] text-white/45 font-mono-tabular">
                    <span>第 {idx + 1} 句</span>
                    <span>{pair.timestamp || '无时间戳'}</span>
                  </div>
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-2.5">
                    <div>
                      <span className="text-[10px] text-white/50 block mb-1">原文</span>
                      <input
                        type="text"
                        value={pair.originalText}
                        onChange={(e) => {
                          const val = e.target.value;
                          setPairsDraft((prev) =>
                            prev.map((item, i) =>
                              i === idx ? { ...item, originalText: val } : item
                            )
                          );
                        }}
                        className="w-full px-3 py-2 rounded-xl bg-white/[0.06] border border-white/12 text-xs text-white focus:outline-none focus:border-white/35"
                      />
                    </div>
                    <div>
                      <span className="text-[10px] text-rose-200/75 block mb-1">译文</span>
                      <input
                        type="text"
                        value={pair.translatedText}
                        onChange={(e) => {
                          const val = e.target.value;
                          setPairsDraft((prev) =>
                            prev.map((item, i) =>
                              i === idx ? { ...item, translatedText: val } : item
                            )
                          );
                        }}
                        placeholder="输入或修改该句中文译文..."
                        className="w-full px-3 py-2 rounded-xl bg-white/[0.06] border border-white/12 text-xs text-rose-100 placeholder-white/30 focus:outline-none focus:border-rose-400/50"
                      />
                    </div>
                  </div>
                </div>
              ))
            )}
          </div>
        ) : (
          <div className="p-5 flex-1 flex flex-col gap-3 min-h-0">
            <div className="flex items-center justify-between">
              <button
                type="button"
                onClick={insertTimestampAtTopOrEnd}
                className="px-3 py-1.5 rounded-lg bg-white/10 hover:bg-white/15 border border-white/12 text-xs text-white/85 flex items-center gap-1.5 transition-colors cursor-pointer"
              >
                <Clock className="w-3.5 h-3.5" />
                插入当前播放时间 {formatLrcTimestamp(currentTime)}
              </button>
              <span className="text-xs text-white/45 font-mono-tabular">
                {draft.split('\n').filter((l) => l.trim()).length} 行
              </span>
            </div>

            <textarea
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              placeholder={`[00:12.40]第一句歌词 // First line translation\n[00:18.00]第二句歌词`}
              className="flex-1 min-h-[260px] w-full p-4 rounded-2xl bg-black/35 border border-white/12 text-sm text-white/90 font-mono-tabular leading-relaxed focus:outline-none focus:border-white/35 resize-none lumina-scroll"
            />
          </div>
        )}

        <div className="px-6 py-4 border-t border-white/10 flex justify-end gap-3 shrink-0">
          <button
            type="button"
            onClick={onClose}
            className="px-4 py-2 rounded-xl bg-white/8 hover:bg-white/14 text-xs font-medium text-white/80 transition-colors cursor-pointer"
          >
            取消
          </button>
          <button
            type="button"
            onClick={() => void handleSaveAction()}
            className="px-5 py-2 rounded-xl text-xs font-medium text-white flex items-center gap-1.5 shadow-lg transition-transform active:scale-95 cursor-pointer"
            style={{
              background: `linear-gradient(135deg, ${palette.primary}, ${palette.secondary})`,
            }}
          >
            <Save className="w-3.5 h-3.5" />
            保存歌词与译文
          </button>
        </div>
      </div>
    </div>
  );
};
