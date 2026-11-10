import React, { useState, useEffect, useCallback } from 'react';
import {
    X, Plus, Trash2, Check, Sparkles, FileText, Upload, FolderOpen,
    Briefcase, Code2, Users, GraduationCap, Compass,
    Layers, BookOpen, CheckCircle2, ChevronRight, AlertCircle, Save
} from 'lucide-react';
import { useResolvedTheme } from '../../hooks/useResolvedTheme';
import { useT } from '../../i18n';
import { useConfirmDialog } from '../ui/ConfirmDialog';

export interface Mode {
    id: string;
    name: string;
    templateType: string;
    customContext: string;
    isActive: boolean;
    createdAt: string;
    isBuiltin: boolean;
    sourceContract?: any;
}

export interface ModeReferenceFile {
    id: string;
    modeId: string;
    fileName: string;
    content: string;
    createdAt: string;
    pageCount?: number;
    extractedPageCount?: number;
}

interface ModesSettingsProps {
    onClose: () => void;
    isPremium?: boolean;
    isLoaded?: boolean;
    isTrialActive?: boolean;
    onOpenNativelyAPI?: () => void;
}

const TEMPLATE_ICONS: Record<string, React.ReactNode> = {
    'general': <Compass size={16} className="text-blue-400" />,
    'looking-for-work': <Briefcase size={16} className="text-amber-400" />,
    'technical-interview': <Code2 size={16} className="text-emerald-400" />,
    'sales': <Sparkles size={16} className="text-purple-400" />,
    'recruiting': <Users size={16} className="text-cyan-400" />,
    'team-meet': <Layers size={16} className="text-indigo-400" />,
    'lecture': <BookOpen size={16} className="text-rose-400" />,
    'seminar': <GraduationCap size={16} className="text-teal-400" />,
};

const TEMPLATE_DESCRIPTIONS: Record<string, string> = {
    'general': 'Universal adaptive copilot for any meeting or conversation.',
    'looking-for-work': 'Optimized for job interviews: structured STAR answers, career narrative alignment.',
    'technical-interview': 'Whiteboard coding, algorithm analysis, complexity checks, and system design.',
    'sales': 'Discovery questioning, objection handling, ROI framing, and deal closing strategies.',
    'recruiting': 'Structured evaluation of candidates, competency probing, and interview scorecards.',
    'team-meet': 'Action items, sprint planning, architectural decisions, and meeting minutes.',
    'lecture': 'Captures key concepts, definitions, historical context, and lecture synthesis.',
    'seminar': 'Academic research, thesis defense, paper discussion, and grounded references.',
};

export const ModesSettings: React.FC<ModesSettingsProps> = ({
    onClose,
}) => {
    const theme = useResolvedTheme();
    const isLight = theme === 'light';
    const t = useT();
    const { confirm: askConfirm, dialog: confirmDialog } = useConfirmDialog();

    const [modes, setModes] = useState<Mode[]>([]);
    const [activeModeId, setActiveModeId] = useState<string | null>(null);
    const [selectedModeId, setSelectedModeId] = useState<string | null>(null);
    const [isLoading, setIsLoading] = useState(true);
    const [isSaving, setIsSaving] = useState(false);
    const [saveSuccess, setSaveSuccess] = useState(false);

    // Selected Mode Form State
    const [nameInput, setNameInput] = useState('');
    const [contextInput, setContextInput] = useState('');
    const [referenceFiles, setReferenceFiles] = useState<ModeReferenceFile[]>([]);
    const [isUploadingFile, setIsUploadingFile] = useState(false);
    const [isCreatingNew, setIsCreatingNew] = useState(false);
    const [newTemplateType, setNewTemplateType] = useState('general');

    const selectedMode = modes.find(m => m.id === selectedModeId) || null;

    // ── Load Modes ─────────────────────────────────────────────────────────────
    const loadModes = useCallback(async () => {
        try {
            const api = (window as any).electronAPI;
            if (!api?.modesGetAll) return;

            const res = await api.modesGetAll();
            const modeList: Mode[] = Array.isArray(res) ? res : res?.modes || [];
            if (modeList.length > 0 || Array.isArray(res)) {
                setModes(modeList);
                const active = modeList.find((m: Mode) => m.isActive);
                if (active) {
                    setActiveModeId(active.id);
                    if (!selectedModeId) {
                        setSelectedModeId(active.id);
                    }
                } else if (modeList.length > 0 && !selectedModeId) {
                    setSelectedModeId(modeList[0].id);
                }
            }
        } catch (err) {
            console.error('[ModesSettings] Failed to load modes:', err);
        } finally {
            setIsLoading(false);
        }
    }, [selectedModeId]);

    useEffect(() => {
        loadModes();
    }, [loadModes]);

    // ── Update Form on Selected Mode Change ─────────────────────────────────────
    useEffect(() => {
        if (selectedMode) {
            setNameInput(selectedMode.name || '');
            setContextInput(selectedMode.customContext || '');
            loadReferenceFiles(selectedMode.id);
        }
    }, [selectedModeId, selectedMode?.id]);

    const loadReferenceFiles = async (modeId: string) => {
        try {
            const api = (window as any).electronAPI;
            if (!api?.modesGetReferenceFiles) return;
            const res = await api.modesGetReferenceFiles(modeId);
            const files = Array.isArray(res) ? res : res?.files || [];
            setReferenceFiles(files);
        } catch {
            setReferenceFiles([]);
        }
    };

    // ── Set Active Mode ────────────────────────────────────────────────────────
    const handleSetActive = async (modeId: string) => {
        try {
            const api = (window as any).electronAPI;
            if (!api?.modesSetActive) return;
            await api.modesSetActive(modeId);
            setActiveModeId(modeId);
            setModes(prev => prev.map(m => ({ ...m, isActive: m.id === modeId })));
        } catch (err) {
            console.error('[ModesSettings] Failed to set active mode:', err);
        }
    };

    // ── Save Changes ───────────────────────────────────────────────────────────
    const handleSave = async () => {
        if (!selectedModeId) return;
        setIsSaving(true);
        try {
            const api = (window as any).electronAPI;
            if (!api?.modesUpdate) return;
            await api.modesUpdate(selectedModeId, {
                name: nameInput.trim() || selectedMode?.name,
                customContext: contextInput.trim(),
            });
            setModes(prev => prev.map(m => m.id === selectedModeId ? {
                ...m,
                name: nameInput.trim() || m.name,
                customContext: contextInput.trim(),
            } : m));
            setSaveSuccess(true);
            setTimeout(() => setSaveSuccess(false), 2000);
        } catch (err) {
            console.error('[ModesSettings] Failed to update mode:', err);
        } finally {
            setIsSaving(false);
        }
    };

    // ── Create New Custom Mode ─────────────────────────────────────────────────
    const handleCreateMode = async () => {
        if (!nameInput.trim()) return;
        setIsSaving(true);
        try {
            const api = (window as any).electronAPI;
            if (!api?.modesCreate) return;
            const res = await api.modesCreate({
                name: nameInput.trim(),
                templateType: newTemplateType,
            });
            const createdMode = res?.mode || (res?.id ? res : null);
            if (createdMode) {
                setModes(prev => [...prev, createdMode]);
                setSelectedModeId(createdMode.id);
                setIsCreatingNew(false);
            }
        } catch (err) {
            console.error('[ModesSettings] Failed to create mode:', err);
        } finally {
            setIsSaving(false);
        }
    };

    // ── Delete Mode ────────────────────────────────────────────────────────────
    const handleDeleteMode = async (modeId: string) => {
        if (!(await askConfirm({
            title: t('Delete custom mode?'),
            description: t('This removes the custom mode and its reference files.'),
            confirmLabel: t('Delete'),
        }))) return;
        try {
            const api = (window as any).electronAPI;
            if (!api?.modesDelete) return;
            await api.modesDelete(modeId);
            setModes(prev => prev.filter(m => m.id !== modeId));
            if (selectedModeId === modeId) {
                const remaining = modes.filter(m => m.id !== modeId);
                setSelectedModeId(remaining.length > 0 ? remaining[0].id : null);
            }
        } catch (err) {
            console.error('[ModesSettings] Failed to delete mode:', err);
        }
    };

    const [isUploadingFolder, setIsUploadingFolder] = useState(false);

    // ── Upload Reference File ──────────────────────────────────────────────────
    const handleUploadFile = async () => {
        if (!selectedModeId) return;
        setIsUploadingFile(true);
        try {
            const api = (window as any).electronAPI;
            if (!api?.modesUploadReferenceFile) return;
            const res = await api.modesUploadReferenceFile(selectedModeId);
            if (res?.files && Array.isArray(res.files)) {
                setReferenceFiles(prev => [...prev, ...res.files]);
            } else if (res?.file) {
                setReferenceFiles(prev => [...prev, res.file]);
            }
        } catch (err) {
            console.error('[ModesSettings] Failed to upload file:', err);
        } finally {
            setIsUploadingFile(false);
        }
    };

    // ── Upload Reference Folder / Repo ──────────────────────────────────────────
    const handleUploadFolder = async () => {
        if (!selectedModeId) return;
        setIsUploadingFolder(true);
        try {
            const api = (window as any).electronAPI;
            if (!api?.modesUploadReferenceFolder) return;
            const res = await api.modesUploadReferenceFolder(selectedModeId);
            if (res?.ingestedFiles && Array.isArray(res.ingestedFiles)) {
                setReferenceFiles(prev => [...prev, ...res.ingestedFiles]);
            }
        } catch (err) {
            console.error('[ModesSettings] Failed to upload folder:', err);
        } finally {
            setIsUploadingFolder(false);
        }
    };

    // ── Delete Reference File ──────────────────────────────────────────────────
    const handleDeleteFile = async (fileId: string) => {
        try {
            const api = (window as any).electronAPI;
            if (!api?.modesDeleteReferenceFile) return;
            await api.modesDeleteReferenceFile(fileId);
            setReferenceFiles(prev => prev.filter(f => f.id !== fileId));
        } catch (err) {
            console.error('[ModesSettings] Failed to delete file:', err);
        }
    };

    return (
        <div className={`flex flex-col h-full w-full select-none ${isLight ? 'bg-slate-50 text-slate-900' : 'bg-[#0f0f11] text-slate-100'}`}>
            {confirmDialog}
            {/* Header */}
            <div className={`flex items-center justify-between px-6 py-4 border-b ${isLight ? 'border-slate-200 bg-white' : 'border-white/10 bg-[#141416]'}`}>
                <div className="flex items-center gap-3">
                    <div className="w-8 h-8 rounded-lg bg-orange-500/15 text-orange-400 flex items-center justify-center">
                        <Layers size={18} />
                    </div>
                    <div>
                        <h2 className="text-[16px] font-semibold tracking-tight">{t('Modes Manager')}</h2>
                        <p className={`text-[12px] ${isLight ? 'text-slate-500' : 'text-slate-400'}`}>
                            {t('Configure specialized formulas and context guidelines for different meeting types.')}
                        </p>
                    </div>
                </div>
                <button
                    onClick={onClose}
                    className={`p-2 rounded-full transition-colors ${isLight ? 'hover:bg-slate-100 text-slate-500' : 'hover:bg-white/10 text-slate-400'}`}
                >
                    <X size={18} />
                </button>
            </div>

            {/* Content Body: Sidebar + Main Detail */}
            <div className="flex flex-1 overflow-hidden">
                {/* Left Sidebar */}
                <div className={`w-[260px] flex flex-col border-r shrink-0 ${isLight ? 'border-slate-200 bg-slate-100/50' : 'border-white/5 bg-[#121214]'}`}>
                    <div className="p-3 border-b border-inherit">
                        <button
                            onClick={() => {
                                setIsCreatingNew(true);
                                setNameInput('');
                                setContextInput('');
                                setNewTemplateType('general');
                            }}
                            className={`w-full flex items-center justify-center gap-2 py-2 px-3 rounded-lg text-[13px] font-medium transition-all duration-200 ${
                                isCreatingNew
                                    ? 'bg-orange-500 text-white shadow-md'
                                    : isLight
                                    ? 'bg-white hover:bg-slate-200/80 text-slate-700 border border-slate-200'
                                    : 'bg-white/5 hover:bg-white/10 text-slate-200 border border-white/10'
                            }`}
                        >
                            <Plus size={15} />
                            <span>{t('New Custom Mode')}</span>
                        </button>
                    </div>

                    {/* Modes List */}
                    <div className="flex-1 overflow-y-auto p-2 space-y-1 custom-scrollbar">
                        {isLoading ? (
                            <div className="p-4 text-center text-xs opacity-50">{t('Loading modes...')}</div>
                        ) : modes.map((mode) => {
                            const isSelected = !isCreatingNew && selectedModeId === mode.id;
                            const isActive = activeModeId === mode.id;
                            const icon = TEMPLATE_ICONS[mode.templateType] || <Compass size={16} />;

                            return (
                                <button
                                    key={mode.id}
                                    onClick={() => {
                                        setIsCreatingNew(false);
                                        setSelectedModeId(mode.id);
                                    }}
                                    className={`w-full flex items-center justify-between p-2.5 rounded-lg text-left transition-all duration-150 group ${
                                        isSelected
                                            ? isLight
                                                ? 'bg-white shadow-sm border border-slate-200 text-slate-900'
                                                : 'bg-white/10 border border-white/15 text-white'
                                            : isLight
                                            ? 'hover:bg-slate-200/50 text-slate-600'
                                            : 'hover:bg-white/5 text-slate-400'
                                    }`}
                                >
                                    <div className="flex items-center gap-2.5 min-w-0 flex-1">
                                        <div className="shrink-0">{icon}</div>
                                        <div className="truncate">
                                            <div className="text-[13px] font-medium truncate">{mode.name}</div>
                                            <div className="text-[10px] opacity-60 capitalize truncate">{mode.templateType.replace('-', ' ')}</div>
                                        </div>
                                    </div>
                                    {isActive && (
                                        <span className="shrink-0 ml-2 px-1.5 py-0.5 rounded text-[10px] font-semibold bg-emerald-500/20 text-emerald-400 border border-emerald-500/30">
                                            ACTIVE
                                        </span>
                                    )}
                                </button>
                            );
                        })}
                    </div>
                </div>

                {/* Right Main Editor Panel */}
                <div className="flex-1 flex flex-col overflow-y-auto custom-scrollbar p-6">
                    {isCreatingNew ? (
                        /* New Mode Creator */
                        <div className="max-w-2xl space-y-6">
                            <div>
                                <h3 className="text-lg font-semibold">{t('Create Custom Mode')}</h3>
                                <p className={`text-xs mt-1 ${isLight ? 'text-slate-500' : 'text-slate-400'}`}>
                                    {t('Choose a template baseline and give your mode a descriptive name.')}
                                </p>
                            </div>

                            <div className="space-y-4">
                                <div>
                                    <label className="block text-xs font-medium mb-1.5">{t('Mode Name')}</label>
                                    <input
                                        type="text"
                                        value={nameInput}
                                        onChange={(e) => setNameInput(e.target.value)}
                                        placeholder="e.g. Senior Frontend System Design"
                                        className={`w-full px-3 py-2 rounded-lg text-sm border focus:outline-none focus:ring-2 focus:ring-orange-500/50 ${
                                            isLight ? 'bg-white border-slate-200' : 'bg-white/5 border-white/10'
                                        }`}
                                    />
                                </div>

                                <div>
                                    <label className="block text-xs font-medium mb-1.5">{t('Base Template')}</label>
                                    <div className="grid grid-cols-2 gap-2">
                                        {Object.entries(TEMPLATE_DESCRIPTIONS).map(([type, desc]) => (
                                            <button
                                                key={type}
                                                type="button"
                                                onClick={() => setNewTemplateType(type)}
                                                className={`p-3 rounded-lg border text-left transition-all ${
                                                    newTemplateType === type
                                                        ? 'border-orange-500 bg-orange-500/10 text-orange-400'
                                                        : isLight
                                                        ? 'border-slate-200 hover:bg-slate-100'
                                                        : 'border-white/10 hover:bg-white/5'
                                                }`}
                                            >
                                                <div className="flex items-center gap-2 font-medium text-xs capitalize">
                                                    {TEMPLATE_ICONS[type]}
                                                    <span>{type.replace('-', ' ')}</span>
                                                </div>
                                                <div className="text-[11px] opacity-60 mt-1 leading-snug">{desc}</div>
                                            </button>
                                        ))}
                                    </div>
                                </div>

                                <div className="flex gap-2 pt-4">
                                    <button
                                        onClick={handleCreateMode}
                                        disabled={!nameInput.trim() || isSaving}
                                        className="px-5 py-2 rounded-lg bg-orange-500 hover:bg-orange-600 text-white font-medium text-xs transition-colors disabled:opacity-50"
                                    >
                                        {isSaving ? t('Creating...') : t('Create Mode')}
                                    </button>
                                    <button
                                        onClick={() => setIsCreatingNew(false)}
                                        className={`px-4 py-2 rounded-lg text-xs font-medium ${isLight ? 'hover:bg-slate-200' : 'hover:bg-white/10'}`}
                                    >
                                        {t('Cancel')}
                                    </button>
                                </div>
                            </div>
                        </div>
                    ) : selectedMode ? (
                        /* Selected Mode Detail & Prompt Editor */
                        <div className="max-w-2xl space-y-6">
                            {/* Mode Header Controls */}
                            <div className="flex items-center justify-between">
                                <div className="flex items-center gap-3">
                                    <div className="p-2.5 rounded-xl bg-white/5 border border-white/10">
                                        {TEMPLATE_ICONS[selectedMode.templateType] || <Compass size={22} />}
                                    </div>
                                    <div>
                                        <div className="flex items-center gap-2">
                                            <input
                                                type="text"
                                                value={nameInput}
                                                disabled={selectedMode.isBuiltin}
                                                onChange={(e) => setNameInput(e.target.value)}
                                                className={`text-lg font-bold bg-transparent border-b border-transparent hover:border-white/20 focus:border-orange-500 focus:outline-none transition-colors ${
                                                    selectedMode.isBuiltin ? 'cursor-default' : ''
                                                }`}
                                            />
                                            {selectedMode.isBuiltin && (
                                                <span className="px-2 py-0.5 rounded-full text-[10px] font-semibold bg-white/10 text-slate-300">
                                                    BUILT-IN
                                                </span>
                                            )}
                                        </div>
                                        <p className={`text-xs mt-0.5 ${isLight ? 'text-slate-500' : 'text-slate-400'}`}>
                                            {TEMPLATE_DESCRIPTIONS[selectedMode.templateType] || 'Specialized AI instruction mode.'}
                                        </p>
                                    </div>
                                </div>

                                <div className="flex items-center gap-2">
                                    {activeModeId !== selectedMode.id ? (
                                        <button
                                            onClick={() => handleSetActive(selectedMode.id)}
                                            className="flex items-center gap-1.5 px-3.5 py-1.5 rounded-lg bg-emerald-500/15 hover:bg-emerald-500/25 border border-emerald-500/30 text-emerald-400 text-xs font-semibold transition-all active:scale-95"
                                        >
                                            <Check size={14} />
                                            <span>{t('Set as Active')}</span>
                                        </button>
                                    ) : (
                                        <span className="flex items-center gap-1 px-3 py-1 rounded-lg bg-emerald-500/20 text-emerald-400 border border-emerald-500/30 text-xs font-semibold">
                                            <CheckCircle2 size={14} />
                                            <span>{t('Active')}</span>
                                        </span>
                                    )}

                                    {!selectedMode.isBuiltin && (
                                        <button
                                            onClick={() => handleDeleteMode(selectedMode.id)}
                                            title="Delete Mode"
                                            className="p-1.5 rounded-lg text-red-400 hover:bg-red-500/10 transition-colors"
                                        >
                                            <Trash2 size={16} />
                                        </button>
                                    )}
                                </div>
                            </div>

                            {/* Custom Context / Prompt Instructions */}
                            <div className="space-y-2">
                                <div className="flex items-center justify-between">
                                    <label className="text-xs font-semibold uppercase tracking-wider text-slate-400">
                                        {t('Custom Context & Prompt Directives')}
                                    </label>
                                    <span className="text-[11px] opacity-40">
                                        {contextInput.length} {t('characters')}
                                    </span>
                                </div>
                                <p className={`text-[12px] leading-relaxed ${isLight ? 'text-slate-600' : 'text-slate-400'}`}>
                                    {t('Add specific guidelines, project backgrounds, technologies, or behavior rules to guide the model when this mode is active.')}
                                </p>
                                <textarea
                                    value={contextInput}
                                    onChange={(e) => setContextInput(e.target.value)}
                                    onBlur={handleSave}
                                    rows={6}
                                    placeholder={t('e.g. Always respond using Python 3 and enforce type hints. Focus on distributed systems trade-offs and latency bottlenecks...')}
                                    className={`w-full p-3 rounded-xl text-xs font-mono border focus:outline-none focus:ring-2 focus:ring-orange-500/40 transition-all ${
                                        isLight ? 'bg-white border-slate-200 text-slate-800' : 'bg-black/30 border-white/10 text-slate-200'
                                    }`}
                                />
                            </div>

                            {/* Reference Documents Section */}
                            <div className="space-y-3 pt-2">
                                <div className="flex items-center justify-between gap-4">
                                    <div>
                                        <h4 className="text-xs font-semibold uppercase tracking-wider text-slate-400">
                                            {t('Reference Files, Code & Knowledge Documents')}
                                        </h4>
                                        <p className={`text-[11px] ${isLight ? 'text-slate-500' : 'text-slate-400'}`}>
                                            {t('Upload CVs, PRDs, single code files, or entire repositories for real-time RAG grounding.')}
                                        </p>
                                    </div>
                                    <div className="flex items-center gap-2 shrink-0">
                                        <button
                                            onClick={handleUploadFile}
                                            disabled={isUploadingFile || isUploadingFolder}
                                            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-white/5 hover:bg-white/10 border border-white/10 text-xs font-medium transition-colors"
                                        >
                                            <Upload size={13} />
                                            <span>{isUploadingFile ? t('Uploading...') : t('Upload Files')}</span>
                                        </button>
                                        <button
                                            onClick={handleUploadFolder}
                                            disabled={isUploadingFile || isUploadingFolder}
                                            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-emerald-500/10 hover:bg-emerald-500/20 border border-emerald-500/20 text-emerald-400 text-xs font-medium transition-colors"
                                        >
                                            <FolderOpen size={13} />
                                            <span>{isUploadingFolder ? t('Scanning...') : t('Upload Repo / Folder')}</span>
                                        </button>
                                    </div>
                                </div>

                                {referenceFiles.length === 0 ? (
                                    <div className={`p-4 rounded-xl border border-dashed text-center text-xs ${isLight ? 'border-slate-300 text-slate-400' : 'border-white/10 text-slate-500'}`}>
                                        {t('No reference documents or code attached to this mode yet.')}
                                    </div>
                                ) : (
                                    <div className="space-y-1.5 max-h-60 overflow-y-auto custom-scrollbar">
                                        {referenceFiles.map((file) => {
                                            const ext = file.fileName.split('.').pop()?.toLowerCase() || '';
                                            const isCode = ['ts', 'tsx', 'js', 'jsx', 'py', 'java', 'go', 'rs', 'cpp', 'c', 'h', 'cs', 'sql', 'sh', 'vue', 'svelte', 'html', 'css', 'yaml', 'yml', 'json'].includes(ext);
                                            const isPdf = ext === 'pdf';
                                            const isDocx = ext === 'docx';
                                            const isMd = ext === 'md' || ext === 'markdown';

                                            return (
                                                <div
                                                    key={file.id}
                                                    className={`flex items-center justify-between p-2.5 rounded-lg border text-xs ${
                                                        isLight ? 'bg-white border-slate-200' : 'bg-white/5 border-white/10'
                                                    }`}
                                                >
                                                    <div className="flex items-center gap-2 truncate">
                                                        {isCode ? (
                                                            <Code2 size={15} className="text-emerald-400 shrink-0" />
                                                        ) : (
                                                            <FileText size={15} className={isPdf ? 'text-rose-400 shrink-0' : isDocx ? 'text-blue-400 shrink-0' : isMd ? 'text-amber-400 shrink-0' : 'text-slate-400 shrink-0'} />
                                                        )}
                                                        <span className="font-medium truncate font-mono text-[11px]">{file.fileName}</span>
                                                        <span className={`text-[9px] px-1.5 py-0.5 rounded font-mono uppercase shrink-0 ${
                                                            isCode ? 'bg-emerald-500/10 text-emerald-400 border border-emerald-500/20' :
                                                            isPdf ? 'bg-rose-500/10 text-rose-400 border border-rose-500/20' :
                                                            isDocx ? 'bg-blue-500/10 text-blue-400 border border-blue-500/20' :
                                                            'bg-slate-500/10 text-slate-400 border border-slate-500/20'
                                                        }`}>
                                                            {ext || 'file'}
                                                        </span>
                                                        {file.pageCount && (
                                                            <span className="text-[10px] opacity-50 shrink-0">({file.pageCount} pgs)</span>
                                                        )}
                                                    </div>
                                                    <button
                                                        onClick={() => handleDeleteFile(file.id)}
                                                        className="text-red-400 hover:text-red-300 p-1 transition-colors"
                                                    >
                                                        <Trash2 size={14} />
                                                    </button>
                                                </div>
                                            );
                                        })}
                                    </div>
                                )}
                            </div>

                            {/* Save Button Bar */}
                            <div className="flex items-center gap-3 pt-4 border-t border-white/5">
                                <button
                                    onClick={handleSave}
                                    disabled={isSaving}
                                    className="flex items-center gap-2 px-5 py-2 rounded-lg bg-orange-500 hover:bg-orange-600 text-white font-medium text-xs transition-all active:scale-95 disabled:opacity-50"
                                >
                                    <Save size={14} />
                                    <span>{isSaving ? t('Saving...') : t('Save Changes')}</span>
                                </button>
                                {saveSuccess && (
                                    <span className="flex items-center gap-1 text-emerald-400 text-xs font-medium animate-fade-in">
                                        <Check size={14} />
                                        <span>{t('Saved successfully!')}</span>
                                    </span>
                                )}
                            </div>
                        </div>
                    ) : (
                        <div className="flex-1 flex items-center justify-center text-xs opacity-40">
                            {t('Select a mode from the sidebar to view or edit')}
                        </div>
                    )}
                </div>
            </div>
        </div>
    );
};

export default ModesSettings;
