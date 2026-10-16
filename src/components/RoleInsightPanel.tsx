import React, { useState, useEffect } from 'react';
import {
    Target,
    CheckCircle2,
    AlertCircle,
    Lightbulb,
    HelpCircle,
    RefreshCw,
    Briefcase,
    FileText,
    ArrowRight,
    TrendingUp,
} from 'lucide-react';

interface RoleInsightProps {
    hasAccess?: boolean;
    onNeedUpgrade?: () => void;
    onGoToProfile?: () => void;
    onGoToTavily?: () => void;
}

export const RoleInsightPanel: React.FC<RoleInsightProps> = ({
    onGoToProfile,
}) => {
    const [status, setStatus] = useState<any>(null);
    const [report, setReport] = useState<any>(null);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState('');

    const fetchStatusAndReport = async () => {
        try {
            const api = (window as any).electronAPI;
            const st = await api?.roleInsightGetStatus?.();
            if (st) setStatus(st);
            const repResult = await api?.roleInsightGetReport?.();
            if (repResult?.success && repResult.report) {
                setReport(repResult.report);
            }
        } catch (err: any) {
            console.error('[RoleInsightPanel] fetch error:', err);
        }
    };

    useEffect(() => {
        fetchStatusAndReport();
    }, []);

    const runAnalysis = async () => {
        setLoading(true);
        setError('');
        try {
            const api = (window as any).electronAPI;
            const res = await api?.roleInsightAnalyse?.();
            if (res?.success && res.report) {
                setReport(res.report);
                setStatus((prev: any) => ({ ...prev, hasAnalysis: true }));
            } else {
                setError(res?.error || 'Analysis could not be completed.');
            }
        } catch (err: any) {
            setError(err.message || 'Analysis failed.');
        } finally {
            setLoading(false);
            fetchStatusAndReport();
        }
    };

    const hasResume = status?.hasResume ?? false;
    const hasJD = status?.hasJobDescription ?? false;
    const hasAnalysis = Boolean(report);

    return (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
            {/* Header */}
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                <div>
                    <h3 className="pi-section-label" style={{ margin: 0, display: 'flex', alignItems: 'center', gap: 8 }}>
                        <Target size={16} style={{ color: 'var(--pi-accent)' }} />
                        Role Insight
                    </h3>
                    <p style={{ fontSize: 12, color: 'var(--pi-secondary)', margin: '4px 0 0', lineHeight: 1.5 }}>
                        Deep intelligence comparing your experience against the target role requirements.
                    </p>
                </div>
                {hasResume && hasAnalysis && (
                    <button
                        className="pi-pill-btn pi-press"
                        disabled={loading}
                        onClick={runAnalysis}
                        style={{ display: 'flex', alignItems: 'center', gap: 6 }}
                    >
                        <RefreshCw size={12} className={loading ? 'pi-spinner' : ''} />
                        {loading ? 'Analyzing…' : 'Re-analyze'}
                    </button>
                )}
            </div>

            {/* Error Banner */}
            {error && (
                <div style={{ fontSize: 12, color: 'var(--pi-danger)', padding: '10px 14px', borderRadius: 8, background: 'var(--pi-danger-bg)', border: '1px solid rgba(239,68,68,0.2)', display: 'flex', alignItems: 'center', gap: 8 }}>
                    <AlertCircle size={14} style={{ flexShrink: 0 }} />
                    <span>{error}</span>
                </div>
            )}

            {/* Empty States */}
            {!hasResume && (
                <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', textAlign: 'center', padding: '36px 24px', border: '1px dashed var(--pi-border)', borderRadius: 12, gap: 12 }}>
                    <div style={{ width: 44, height: 44, borderRadius: 22, background: 'var(--pi-accent-subtle)', border: '1px solid var(--pi-badge-border)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                        <FileText size={20} style={{ color: 'var(--pi-accent-icon)' }} />
                    </div>
                    <div>
                        <div style={{ fontSize: 14, fontWeight: 600, color: 'var(--pi-primary)', marginBottom: 4 }}>Resume required</div>
                        <div style={{ fontSize: 12, color: 'var(--pi-secondary)', lineHeight: 1.6, maxWidth: 280 }}>
                            Upload your resume in <strong style={{ color: 'var(--pi-primary)' }}>Identity</strong> to unlock Role Insight analysis.
                        </div>
                    </div>
                    {onGoToProfile && (
                        <button
                            className="pi-pill-btn pi-press"
                            style={{ color: 'var(--pi-cta-accent-text)', borderColor: 'var(--pi-cta-accent-border)', background: 'var(--pi-accent-subtle)', fontWeight: 600, padding: '8px 20px', display: 'flex', alignItems: 'center', gap: 6 }}
                            onClick={onGoToProfile}
                        >
                            Go to Identity <ArrowRight size={13} />
                        </button>
                    )}
                </div>
            )}

            {hasResume && !hasAnalysis && (
                <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', textAlign: 'center', padding: '36px 24px', border: '1px dashed var(--pi-border)', borderRadius: 12, gap: 14 }}>
                    <div style={{ width: 44, height: 44, borderRadius: 22, background: 'var(--pi-accent-subtle)', border: '1px solid var(--pi-badge-border)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                        <TrendingUp size={20} style={{ color: 'var(--pi-accent)' }} />
                    </div>
                    <div>
                        <div style={{ fontSize: 14, fontWeight: 600, color: 'var(--pi-primary)', marginBottom: 4 }}>Ready for analysis</div>
                        <div style={{ fontSize: 12, color: 'var(--pi-secondary)', lineHeight: 1.6, maxWidth: 360 }}>
                            {hasJD
                                ? 'Evaluate how your experience, skills, and background align with your uploaded job description.'
                                : 'Run strategic evaluation of your profile strengths, talking points, and anticipated interview questions.'}
                        </div>
                    </div>
                    <button
                        className="pi-pill-btn pi-press"
                        disabled={loading}
                        style={{ color: 'var(--pi-cta-accent-text)', borderColor: 'var(--pi-cta-accent-border)', background: 'var(--pi-accent-subtle)', fontWeight: 600, padding: '10px 24px', display: 'flex', alignItems: 'center', gap: 8 }}
                        onClick={runAnalysis}
                    >
                        {loading ? <RefreshCw size={14} className="pi-spinner" /> : <Target size={14} />}
                        {loading ? 'Evaluating match…' : 'Generate Role Insights'}
                    </button>
                </div>
            )}

            {/* Analysis Results */}
            {hasAnalysis && report && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
                    {/* Hero Score Card */}
                    <div style={{ padding: '18px 20px', borderRadius: 12, background: 'var(--pi-btn-bg)', border: '1px solid var(--pi-btn-border)', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 20, flexWrap: 'wrap' }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
                            <div style={{ width: 56, height: 56, borderRadius: '50%', background: 'rgba(34,197,94,0.12)', border: '2px solid rgba(34,197,94,0.4)', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
                                <span style={{ fontSize: 18, fontWeight: 800, color: '#22c55e', fontVariantNumeric: 'tabular-nums' }}>
                                    {report.overallFit?.score ?? 85}%
                                </span>
                            </div>
                            <div>
                                <div style={{ fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.08em', color: '#22c55e', marginBottom: 2 }}>
                                    {report.overallFit?.label ?? 'Strong Fit'}
                                </div>
                                <div style={{ fontSize: 14, fontWeight: 600, color: 'var(--pi-primary)' }}>
                                    {report.roleMatch?.title || 'Target Position'}
                                    {report.roleMatch?.company && <span style={{ color: 'var(--pi-secondary)', fontWeight: 400 }}> · {report.roleMatch.company}</span>}
                                </div>
                            </div>
                        </div>

                        {report.seniorityFit && (
                            <div style={{ padding: '6px 12px', borderRadius: 8, background: 'var(--pi-badge-bg)', border: '1px solid var(--pi-badge-border)', fontSize: 12, color: 'var(--pi-secondary)' }}>
                                <span style={{ fontWeight: 600, color: 'var(--pi-primary)' }}>Seniority:</span> {report.seniorityFit.match}
                            </div>
                        )}
                    </div>

                    {/* Summary */}
                    {report.overallFit?.summary && (
                        <p style={{ fontSize: 13, lineHeight: 1.6, color: 'var(--pi-primary)', margin: 0, padding: '0 4px' }}>
                            {report.overallFit.summary}
                        </p>
                    )}

                    {/* 2-Column Grid: Strengths & Gaps */}
                    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))', gap: 14 }}>
                        {/* Strengths */}
                        <div className="pi-section-card" style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                            <div className="pi-section-header">
                                <span className="pi-section-header-icon" style={{ color: '#22c55e' }}>
                                    <CheckCircle2 size={13} />
                                </span>
                                <h4 className="pi-section-header-label">Key Strengths & Evidence</h4>
                            </div>
                            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                                {(report.strengths || []).map((s: any, i: number) => (
                                    <div key={i} style={{ padding: '8px 10px', borderRadius: 6, background: 'rgba(34,197,94,0.04)', border: '1px solid rgba(34,197,94,0.15)' }}>
                                        <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--pi-primary)', marginBottom: 2 }}>{s.title}</div>
                                        <div style={{ fontSize: 11, color: 'var(--pi-secondary)', lineHeight: 1.4 }}>{s.evidence}</div>
                                    </div>
                                ))}
                            </div>
                        </div>

                        {/* Gaps & Advice */}
                        <div className="pi-section-card" style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                            <div className="pi-section-header">
                                <span className="pi-section-header-icon" style={{ color: '#f59e0b' }}>
                                    <AlertCircle size={13} />
                                </span>
                                <h4 className="pi-section-header-label">Gaps & Bridge Advice</h4>
                            </div>
                            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                                {(report.gaps || []).map((g: any, i: number) => (
                                    <div key={i} style={{ padding: '8px 10px', borderRadius: 6, background: 'rgba(245,158,11,0.04)', border: '1px solid rgba(245,158,11,0.15)' }}>
                                        <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--pi-primary)', marginBottom: 2 }}>{g.area}</div>
                                        <div style={{ fontSize: 11, color: 'var(--pi-secondary)', lineHeight: 1.4 }}>{g.recommendation}</div>
                                    </div>
                                ))}
                            </div>
                        </div>
                    </div>

                    {/* Interview Talking Points */}
                    {Array.isArray(report.talkingPoints) && report.talkingPoints.length > 0 && (
                        <div className="pi-section-card" style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                            <div className="pi-section-header">
                                <span className="pi-section-header-icon" style={{ color: 'var(--pi-accent)' }}>
                                    <Lightbulb size={13} />
                                </span>
                                <h4 className="pi-section-header-label">Strategic Talking Points</h4>
                            </div>
                            <ul style={{ margin: 0, padding: '0 0 0 16px', display: 'flex', flexDirection: 'column', gap: 6, fontSize: 12, color: 'var(--pi-primary)', lineHeight: 1.5 }}>
                                {report.talkingPoints.map((tp: string, i: number) => (
                                    <li key={i}>{tp}</li>
                                ))}
                            </ul>
                        </div>
                    )}

                    {/* Questions To Expect */}
                    {Array.isArray(report.questionsToExpect) && report.questionsToExpect.length > 0 && (
                        <div className="pi-section-card" style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                            <div className="pi-section-header">
                                <span className="pi-section-header-icon" style={{ color: 'var(--pi-accent)' }}>
                                    <HelpCircle size={13} />
                                </span>
                                <h4 className="pi-section-header-label">Anticipated Interview Questions</h4>
                            </div>
                            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                                {report.questionsToExpect.map((q: string, i: number) => (
                                    <div key={i} style={{ padding: '8px 12px', borderRadius: 6, background: 'var(--pi-btn-bg)', border: '1px solid var(--pi-border)', fontSize: 12, color: 'var(--pi-primary)', lineHeight: 1.4 }}>
                                        "{q}"
                                    </div>
                                ))}
                            </div>
                        </div>
                    )}
                </div>
            )}
        </div>
    );
};
