import { randomUUID } from 'node:crypto'

type SkillVector = {
    localNicheCompiler: number
    globalGaugeTransformer: number
}

const INITIAL_TEACHER_CONFIDENCE_SCORE = 0.55
const INITIAL_STUDENT_SKILL = 0.5
const INITIAL_ECHO_TRACE = 0.5
const ECHO_DECAY_RATE = 0.92
const ECHO_UPDATE_RATE = 0.08
const NOVELTY_BOOST_MULTIPLIER = 1.25
const MAX_CHECKPOINTS = 20
const GLOBAL_DIVERGENCE_CAP = 0.5

type NicheAdaptiveState = {
    teacher: SkillVector
    student: SkillVector
    echoTrace: number
    novelty: number
    interactions: number
    successes: number
    divergence: number
    lastUpdatedAt: number
}

export type AdaptivePhase =
    | 'offline_simulation'
    | 'shadow'
    | 'constrained_action'
    | 'gradual_autonomy'

type GaugeState = {
    coherence: number
    drift: number
    couplingStrength: number
    totalInteractions: number
    updateBudgetUsedLastMinute: number
}

type AdaptiveControls = {
    phase: AdaptivePhase
    couplingStrength: number
    teacherRate: number
    studentRate: number
    updateBudgetPerMinute: number
    divergenceThreshold: number
    noveltyThreshold: number
    canaryNiches: string[]
}

export type AdaptivePolicyDecision = {
    allow: boolean
    enforced: boolean
    reason: string
    niche: string
    teacherConfidence: number
    studentConfidence: number
    divergence: number
    risk: number
}

type InteractionRecord = {
    actionName: string
    niche: string
    success: boolean
    latencyMs: number
}

type StatusNiche = {
    teacher: SkillVector
    student: SkillVector
    divergence: number
    interactions: number
    successes: number
    successRate: number
    echoTrace: number
    novelty: number
    canary: boolean
}

type Snapshot = {
    id: string
    label?: string
    createdAt: number
    controls: AdaptiveControls
    gauge: GaugeState
    niches: [string, NicheAdaptiveState][]
}

type GaugeSnapshot = {
    coherence: number
    drift: number
    couplingStrength: number
    totalInteractions: number
    updateBudgetUsedLastMinute: number
}

type AdaptiveStatus = {
    controls: AdaptiveControls
    gauge: GaugeSnapshot
    checkpoints: { id: string; label?: string; createdAt: number }[]
    niches: Record<string, StatusNiche>
}

function clamp01(value: number): number {
    if (Number.isNaN(value)) return 0
    return Math.max(0, Math.min(1, value))
}

function now(): number {
    return Date.now()
}

function average(values: number[]): number {
    if (!values.length) return 0
    return values.reduce((sum, v) => sum + v, 0) / values.length
}

export class AdaptiveTrainerSystem {
    private niches = new Map<string, NicheAdaptiveState>()
    private checkpoints: Snapshot[] = []
    private updateTimestamps: number[] = []

    private controls: AdaptiveControls = {
        phase: 'shadow',
        couplingStrength: 0.35,
        teacherRate: 0.03,
        studentRate: 0.09,
        updateBudgetPerMinute: 240,
        divergenceThreshold: 0.45,
        noveltyThreshold: 0.2,
        canaryNiches: ['containers'],
    }

    private gauge: GaugeState = {
        coherence: 0.5,
        drift: 0,
        couplingStrength: this.controls.couplingStrength,
        totalInteractions: 0,
        updateBudgetUsedLastMinute: 0,
    }

    constructor() {
        this.createCheckpoint('bootstrap')
    }

    public evaluateAction(actionName: string, niche = this.resolveNiche(actionName)): AdaptivePolicyDecision {
        const state = this.ensureNiche(niche)
        const teacherConfidence = average([
            state.teacher.localNicheCompiler,
            state.teacher.globalGaugeTransformer,
        ])
        const studentConfidence = average([
            state.student.localNicheCompiler,
            state.student.globalGaugeTransformer,
        ])
        const divergence = Math.abs(teacherConfidence - studentConfidence)
        state.divergence = divergence

        const risk = clamp01(
            1 - (
                (teacherConfidence * this.controls.couplingStrength)
                + (studentConfidence * (1 - this.controls.couplingStrength))
            ),
        )

        const updateBudgetExceeded = this.isUpdateBudgetExceeded()
        const shouldEnforce = this.controls.phase === 'constrained_action' || this.controls.phase === 'gradual_autonomy'

        if (this.controls.phase === 'offline_simulation') {
            return {
                allow: false,
                enforced: true,
                reason: 'Adaptive trainer is in offline simulation mode; action execution is disabled.',
                niche,
                teacherConfidence,
                studentConfidence,
                divergence,
                risk,
            }
        }

        if (!shouldEnforce) {
            return {
                allow: true,
                enforced: false,
                reason: 'Shadow mode active; adaptive policy observing only.',
                niche,
                teacherConfidence,
                studentConfidence,
                divergence,
                risk,
            }
        }

        if (updateBudgetExceeded) {
            return {
                allow: false,
                enforced: true,
                reason: 'Adaptive update budget exceeded; conservative fallback applied.',
                niche,
                teacherConfidence,
                studentConfidence,
                divergence,
                risk,
            }
        }

        if (divergence > this.controls.divergenceThreshold) {
            return {
                allow: false,
                enforced: true,
                reason: 'Teacher/student divergence exceeded threshold; conservative fallback applied.',
                niche,
                teacherConfidence,
                studentConfidence,
                divergence,
                risk,
            }
        }

        return {
            allow: true,
            enforced: true,
            reason: 'Adaptive gate accepted action.',
            niche,
            teacherConfidence,
            studentConfidence,
            divergence,
            risk,
        }
    }

    public recordInteraction(interaction: InteractionRecord): void {
        const state = this.ensureNiche(interaction.niche)
        const target = interaction.success ? 1 : 0
        const novelty = clamp01(Math.abs(state.echoTrace - target))
        state.novelty = novelty
        state.echoTrace = clamp01((state.echoTrace * ECHO_DECAY_RATE) + (target * ECHO_UPDATE_RATE))

        const noveltyBoost = novelty > this.controls.noveltyThreshold ? NOVELTY_BOOST_MULTIPLIER : 1
        const studentRate = this.controls.studentRate * noveltyBoost
        const teacherRate = this.controls.teacherRate

        state.student.localNicheCompiler = this.nextSkill(state.student.localNicheCompiler, target, studentRate)
        state.student.globalGaugeTransformer = this.nextSkill(
            state.student.globalGaugeTransformer,
            target * (1 - Math.min(GLOBAL_DIVERGENCE_CAP, state.divergence)),
            studentRate,
        )

        const studentLocal = state.student.localNicheCompiler
        const studentGlobal = state.student.globalGaugeTransformer
        state.teacher.localNicheCompiler = this.nextSkill(state.teacher.localNicheCompiler, studentLocal, teacherRate)
        state.teacher.globalGaugeTransformer = this.nextSkill(state.teacher.globalGaugeTransformer, studentGlobal, teacherRate)

        state.interactions += 1
        if (interaction.success) state.successes += 1
        state.lastUpdatedAt = now()

        this.updateTimestamps.push(now())
        this.pruneUpdateWindow()

        this.gauge.totalInteractions += 1
        this.gauge.updateBudgetUsedLastMinute = this.updateTimestamps.length
        this.recomputeGauge()
    }

    public getStatus(): AdaptiveStatus {
        const niches: Record<string, StatusNiche> = {}
        for (const [name, state] of this.niches.entries()) {
            niches[name] = {
                teacher: { ...state.teacher },
                student: { ...state.student },
                divergence: state.divergence,
                interactions: state.interactions,
                successes: state.successes,
                successRate: state.interactions ? state.successes / state.interactions : 0,
                echoTrace: state.echoTrace,
                novelty: state.novelty,
                canary: this.controls.canaryNiches.includes(name),
            }
        }

        return {
            controls: { ...this.controls, canaryNiches: [...this.controls.canaryNiches] },
            gauge: {
                coherence: this.gauge.coherence,
                drift: this.gauge.drift,
                couplingStrength: this.gauge.couplingStrength,
                totalInteractions: this.gauge.totalInteractions,
                updateBudgetUsedLastMinute: this.gauge.updateBudgetUsedLastMinute,
            },
            checkpoints: this.checkpoints.map((c) => ({ id: c.id, label: c.label, createdAt: c.createdAt })),
            niches,
        }
    }

    public updateControls(input: Partial<AdaptiveControls>): AdaptiveControls {
        const next: AdaptiveControls = {
            ...this.controls,
            ...input,
            couplingStrength: input.couplingStrength !== undefined ? clamp01(input.couplingStrength) : this.controls.couplingStrength,
            teacherRate: input.teacherRate !== undefined ? clamp01(input.teacherRate) : this.controls.teacherRate,
            studentRate: input.studentRate !== undefined ? clamp01(input.studentRate) : this.controls.studentRate,
            updateBudgetPerMinute: input.updateBudgetPerMinute !== undefined
                ? Math.max(1, Math.floor(input.updateBudgetPerMinute))
                : this.controls.updateBudgetPerMinute,
            divergenceThreshold: input.divergenceThreshold !== undefined ? clamp01(input.divergenceThreshold) : this.controls.divergenceThreshold,
            noveltyThreshold: input.noveltyThreshold !== undefined ? clamp01(input.noveltyThreshold) : this.controls.noveltyThreshold,
            canaryNiches: Array.isArray(input.canaryNiches) ? input.canaryNiches.filter(Boolean) : this.controls.canaryNiches,
        }
        this.controls = next
        this.gauge.couplingStrength = next.couplingStrength
        return { ...next, canaryNiches: [...next.canaryNiches] }
    }

    public createCheckpoint(label?: string): { id: string; label?: string; createdAt: number } {
        const snapshot: Snapshot = {
            id: randomUUID(),
            label,
            createdAt: now(),
            controls: {
                ...this.controls,
                canaryNiches: [...this.controls.canaryNiches],
            },
            gauge: {
                ...this.gauge,
            },
            niches: Array.from(this.niches.entries()).map(([name, state]) => [name, {
                teacher: { ...state.teacher },
                student: { ...state.student },
                echoTrace: state.echoTrace,
                novelty: state.novelty,
                interactions: state.interactions,
                successes: state.successes,
                divergence: state.divergence,
                lastUpdatedAt: state.lastUpdatedAt,
            }]),
        }

        this.checkpoints.unshift(snapshot)
        this.checkpoints = this.checkpoints.slice(0, MAX_CHECKPOINTS)
        return { id: snapshot.id, label: snapshot.label, createdAt: snapshot.createdAt }
    }

    public rollback(checkpointId: string): boolean {
        const snapshot = this.checkpoints.find((c) => c.id === checkpointId)
        if (!snapshot) return false

        this.controls = {
            ...snapshot.controls,
            canaryNiches: [...snapshot.controls.canaryNiches],
        }
        this.gauge = { ...snapshot.gauge }
        this.niches = new Map(
            snapshot.niches.map(([name, state]) => [
                name,
                {
                    teacher: { ...state.teacher },
                    student: { ...state.student },
                    echoTrace: state.echoTrace,
                    novelty: state.novelty,
                    interactions: state.interactions,
                    successes: state.successes,
                    divergence: state.divergence,
                    lastUpdatedAt: state.lastUpdatedAt,
                },
            ]),
        )
        return true
    }

    public resolveNiche(actionName: string): string {
        if (actionName.includes('container')) return 'containers'
        if (actionName.includes('image')) return 'images'
        if (actionName.includes('network')) return 'networks'
        if (actionName.includes('volume')) return 'volumes'
        return 'misc'
    }

    private ensureNiche(niche: string): NicheAdaptiveState {
        const existing = this.niches.get(niche)
        if (existing) return existing
        const seeded: NicheAdaptiveState = {
            teacher: {
                localNicheCompiler: INITIAL_TEACHER_CONFIDENCE_SCORE,
                globalGaugeTransformer: INITIAL_TEACHER_CONFIDENCE_SCORE,
            },
            student: {
                localNicheCompiler: INITIAL_STUDENT_SKILL,
                globalGaugeTransformer: INITIAL_STUDENT_SKILL,
            },
            echoTrace: INITIAL_ECHO_TRACE,
            novelty: 0,
            interactions: 0,
            successes: 0,
            divergence: 0,
            lastUpdatedAt: now(),
        }
        this.niches.set(niche, seeded)
        return seeded
    }

    private nextSkill(current: number, target: number, rate: number): number {
        return clamp01(current + ((target - current) * rate))
    }

    private pruneUpdateWindow(): void {
        const minuteAgo = now() - 60_000
        const firstInRangeIdx = this.updateTimestamps.findIndex((ts) => ts >= minuteAgo)
        if (firstInRangeIdx === -1) {
            this.updateTimestamps = []
            return
        }
        if (firstInRangeIdx > 0) this.updateTimestamps = this.updateTimestamps.slice(firstInRangeIdx)
    }

    private isUpdateBudgetExceeded(): boolean {
        this.pruneUpdateWindow()
        return this.updateTimestamps.length > this.controls.updateBudgetPerMinute
    }

    private recomputeGauge(): void {
        const states = Array.from(this.niches.values())
        const divergences = states.map((s) => s.divergence)
        const localTeacher = states.map((s) => s.teacher.localNicheCompiler)
        const localStudent = states.map((s) => s.student.localNicheCompiler)

        const avgTeacher = average(localTeacher)
        const avgStudent = average(localStudent)
        this.gauge.drift = Math.abs(avgTeacher - avgStudent)
        this.gauge.coherence = clamp01(1 - average(divergences))
    }
}
