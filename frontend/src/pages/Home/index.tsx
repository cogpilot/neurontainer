import { useEffect, useState } from 'preact/hooks';
import {
	Box,
	Typography,
	Button,
	Card,
	CardContent,
	TextField,
	Stack,
	CircularProgress,
	Alert,
	MenuItem
} from '@mui/material';
import { createDockerDesktopClient } from '@docker/extension-api-client';
import './style.css';

function stringifyAny(v: unknown) {
	try {
		if (v instanceof Error) return `${v.name}: ${v.message}\n${v.stack ?? ''}`.trim();
		if (typeof v === 'string') return v;
		return JSON.stringify(v, null, 2);
	} catch {
		return String(v);
	}
}

let ddClient: ReturnType<typeof createDockerDesktopClient> | undefined;
let ddClientInitError: string | null = null;
try {
	ddClient = createDockerDesktopClient();
} catch (err) {
	ddClientInitError = stringifyAny(err);
	// eslint-disable-next-line no-console
	console.error('Failed to initialize Docker Desktop client', err);
}

function normalizeResponse(raw: any) {
	if (typeof raw === 'string') {
		try {
			return JSON.parse(raw);
		} catch {
			return { success: false, error: raw };
		}
	}
	return raw;
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
	let timeoutHandle: number | undefined;
	const timeoutPromise = new Promise<never>((_, reject) => {
		timeoutHandle = window.setTimeout(() => {
			reject(new Error(`${label} timed out after ${timeoutMs}ms`));
		}, timeoutMs);
	});
	try {
		return await Promise.race([promise, timeoutPromise]);
	} finally {
		if (timeoutHandle !== undefined) window.clearTimeout(timeoutHandle);
	}
}

type AdaptivePhase = 'offline_simulation' | 'shadow' | 'constrained_action' | 'gradual_autonomy'

interface AdaptiveStatus {
	controls: {
		phase: AdaptivePhase
		couplingStrength: number
		teacherRate: number
		studentRate: number
		updateBudgetPerMinute: number
		divergenceThreshold: number
		noveltyThreshold: number
		canaryNiches: string[]
	}
	gauge: {
		coherence: number
		drift: number
		couplingStrength: number
		totalInteractions: number
		updateBudgetUsedLastMinute: number
	}
	checkpoints: Array<{ id: string; label?: string; createdAt: number }>
	niches: Record<string, {
		interactions: number
		successRate: number
		divergence: number
		echoTrace: number
		novelty: number
		canary: boolean
		teacher: { localNicheCompiler: number; globalGaugeTransformer: number }
		student: { localNicheCompiler: number; globalGaugeTransformer: number }
	}>
}

function formatAdaptiveNicheSummary(niches: AdaptiveStatus['niches']): string {
	const summary = Object.entries(niches).map(([n, v]) =>
		`${n}: ${v.successRate.toFixed(2)} sr, ${v.divergence.toFixed(2)} div${v.canary ? ' [canary]' : ''}`,
	);
	return summary.join(' | ') || 'none';
}

export function Home() {
	const [websocketUrl, setWebsocketUrl] = useState('ws://host.docker.internal:8000');
	const [backendStatus, setBackendStatus] = useState<any>(null);
	const [adaptiveStatus, setAdaptiveStatus] = useState<AdaptiveStatus | null>(null);
	const [adaptivePhase, setAdaptivePhase] = useState<AdaptivePhase>('shadow');
	const [neuroLoading, setNeuroLoading] = useState(false);
	const [dockerLoading, setDockerLoading] = useState(false);
	const [adaptiveLoading, setAdaptiveLoading] = useState(false);
	const [adaptivePhaseLoading, setAdaptivePhaseLoading] = useState(false);
	const [adaptiveCheckpointLoading, setAdaptiveCheckpointLoading] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [success, setSuccess] = useState<string | null>(null);
	const [lastReconnectRaw, setLastReconnectRaw] = useState<string | null>(null);

	const refreshAdaptive = async () => {
		try {
			if (!ddClient) return;
			setAdaptiveLoading(true);
			const raw = await ddClient.extension.vm.service.get('/api/adaptive/status');
			const response = normalizeResponse(raw) as any;
			if (response?.success && response?.status) {
				setAdaptiveStatus(response.status as AdaptiveStatus);
				const nextPhase = (response.status as AdaptiveStatus).controls?.phase;
				if (nextPhase) setAdaptivePhase(nextPhase);
			}
		} catch {
			// ignore
		} finally {
			setAdaptiveLoading(false);
		}
	};

	const refreshStatus = async () => {
		try {
			if (!ddClient) return;
			const [status] = await Promise.all([
				ddClient.extension.vm.service.get('/api/status'),
				refreshAdaptive(),
			]);
			setBackendStatus(status);
			// Prefer backend's current URL if present.
			if ((status as any)?.neuro_server) setWebsocketUrl((status as any).neuro_server);
		} catch {
			// ignore
		}
	};

	useEffect(() => {
		refreshStatus();
	}, []);

	const handleAdaptivePhaseSave = async () => {
		try {
			if (!ddClient) throw new Error('Docker Desktop extension API client is unavailable');
			setAdaptivePhaseLoading(true);
			setError(null);
			const raw = await withTimeout(
				ddClient.extension.vm.service.put('/api/adaptive/controls', { controls: { phase: adaptivePhase } }) as any,
				15000,
				'Adaptive control update',
			);
			const response = normalizeResponse(raw) as any;
			if (!response?.success) throw new Error(response?.error || 'Failed to update adaptive phase');
			setSuccess(`Adaptive phase updated to "${adaptivePhase}"`);
			await refreshAdaptive();
		} catch (err) {
			setError(`Failed to update adaptive phase.\n\n${stringifyAny(err)}`);
		} finally {
			setAdaptivePhaseLoading(false);
		}
	};

	const handleAdaptiveCheckpoint = async () => {
		try {
			if (!ddClient) throw new Error('Docker Desktop extension API client is unavailable');
			setAdaptiveCheckpointLoading(true);
			setError(null);
			const raw = await withTimeout(
				ddClient.extension.vm.service.post('/api/adaptive/checkpoint', { label: 'manual' }) as any,
				15000,
				'Adaptive checkpoint creation',
			);
			const response = normalizeResponse(raw) as any;
			if (!response?.success) throw new Error(response?.error || 'Failed to create checkpoint');
			setSuccess(`Adaptive checkpoint created (${response?.checkpoint?.id ?? 'unknown id'})`);
			await refreshAdaptive();
		} catch (err) {
			setError(`Failed to create adaptive checkpoint.\n\n${stringifyAny(err)}`);
		} finally {
			setAdaptiveCheckpointLoading(false);
		}
	};

	const handleAdaptiveRollbackLatest = async () => {
		try {
			if (!ddClient) throw new Error('Docker Desktop extension API client is unavailable');
			const latestCheckpointId = adaptiveStatus?.checkpoints?.[0]?.id;
			if (!latestCheckpointId) throw new Error('No adaptive checkpoint is available');
			setAdaptiveCheckpointLoading(true);
			setError(null);
			const raw = await withTimeout(
				ddClient.extension.vm.service.post('/api/adaptive/rollback', { checkpointId: latestCheckpointId }) as any,
				15000,
				'Adaptive rollback',
			);
			const response = normalizeResponse(raw) as any;
			if (!response?.success) throw new Error(response?.error || 'Failed to rollback checkpoint');
			setSuccess(`Rolled back adaptive state to checkpoint ${latestCheckpointId}`);
			await refreshAdaptive();
		} catch (err) {
			setError(`Failed to rollback adaptive state.\n\n${stringifyAny(err)}`);
		} finally {
			setAdaptiveCheckpointLoading(false);
		}
	};

	const handleReconnect = async () => {
		try {
			if (!ddClient) {
				throw new Error(
					`Docker Desktop extension API client is unavailable${ddClientInitError ? `: ${ddClientInitError}` : ''}`
				);
			}
			setNeuroLoading(true);
			setError(null);
			setSuccess(null);
			setLastReconnectRaw(null);

			const raw = await withTimeout(
				ddClient.extension.vm.service.post('/api/reconnect/neuro', { websocketUrl }) as any,
				15000,
				'Neuro reconnect request'
			);
			setLastReconnectRaw(stringifyAny(raw));
			const response = normalizeResponse(raw) as any;

			if (response?.success === true || response?.websocketUrl || response?.message) {
				setSuccess(
					`NeuroClient connected: ${response.websocketUrl ?? websocketUrl}\n\nResponse:\n${stringifyAny(response)}`
				);
				await refreshStatus();
				try {
					ddClient.desktopUI.toast.success('NeuroClient reconnected');
				} catch {
					// ignore toast failures
				}
			} else {
				throw new Error(response?.error || `Reconnect failed. Raw response:\n${stringifyAny(raw)}`);
			}
		} catch (err) {
			const errorMsg = `Failed to reconnect NeuroClient.\n\n${stringifyAny(err)}`;
			setLastReconnectRaw(`(error)\n${stringifyAny(err)}`);
			setError(errorMsg);
			// Re-enable the button immediately; refresh status in the background.
			setNeuroLoading(false);
			void refreshStatus();
			try {
				ddClient?.desktopUI.toast.error('Failed to reconnect NeuroClient');
			} catch {
				// ignore toast failures
			}
		} finally {
			setNeuroLoading(false);
		}
	};

	const handleDockerReconnect = async () => {
		try {
			if (!ddClient) {
				throw new Error(
					`Docker Desktop extension API client is unavailable${ddClientInitError ? `: ${ddClientInitError}` : ''}`
				);
			}
			setDockerLoading(true);
			setError(null);
			setSuccess(null);

			const raw = await withTimeout(
				ddClient.extension.vm.service.post('/api/reconnect/docker', {}) as any,
				15000,
				'Docker reconnect request'
			);
			const response = normalizeResponse(raw) as any;

			if (response?.success === true) {
				setSuccess(
					`Docker client reconnected successfully\n\nResponse:\n${stringifyAny(response)}`
				);
				await refreshStatus();
				try {
					ddClient.desktopUI.toast.success('Docker client reconnected');
				} catch {
					// ignore toast failures
				}
			} else {
				throw new Error(response?.error || `Docker reconnect failed. Raw response:\n${stringifyAny(raw)}`);
			}
		} catch (err) {
			const errorMsg = `Failed to reconnect Docker client.\n\n${stringifyAny(err)}`;
			setError(errorMsg);
			// Re-enable the button immediately; refresh status in the background.
			setDockerLoading(false);
			void refreshStatus();
			try {
				ddClient?.desktopUI.toast.error('Failed to reconnect Docker client');
			} catch {
				// ignore toast failures
			}
		} finally {
			setDockerLoading(false);
		}
	};

	return (
		<Box sx={{ p: 3, maxWidth: 800, mx: 'auto' }}>

			{ddClientInitError && (
				<Alert severity="warning" sx={{ mb: 2 }}>
					Docker Desktop API client failed to initialize: {ddClientInitError}
				</Alert>
			)}
			{backendStatus && (
				<Alert severity="info" sx={{ mb: 2 }}>
					Backend reports Neuro: {(backendStatus as any)?.neuro ?? 'unknown'} (server {(backendStatus as any)?.neuro_server ?? 'unknown'}) — ws {(backendStatus as any)?.neuro_ws ?? 'unknown'}
					<br />
					Last event: {JSON.stringify((backendStatus as any)?.last_neuro_event ?? null)}
					<br />
					Last reconnect request: {JSON.stringify((backendStatus as any)?.last_reconnect_request ?? null)}
				</Alert>
			)}
			{error && <Alert severity="error" sx={{ mb: 2 }}>{error}</Alert>}
			{success && <Alert severity="success" sx={{ mb: 2 }}>{success}</Alert>}
			{lastReconnectRaw && (
				<Alert severity="info" sx={{ mb: 2 }}>
					Last reconnect raw response:
					<pre style={{ margin: 0, whiteSpace: 'pre-wrap' }}>{lastReconnectRaw}</pre>
				</Alert>
			)}

			<Card>
				<CardContent>
					<Typography variant="h6" gutterBottom>
						WebSocket Connection
					</Typography>

					<Stack spacing={3}>
						<TextField
							label="WebSocket URL"
							value={websocketUrl}
							onChange={(e) => setWebsocketUrl(e.target.value)}
							fullWidth
							placeholder="ws://localhost:8000"
							helperText="Tip: use ws://host.docker.internal:8000 to reach a Neuro server running on your host (inside the extension container, ws://localhost points to itself)."
							disabled={neuroLoading}
						/>

						<Button
							variant="contained"
							onClick={handleReconnect}
							disabled={neuroLoading || !websocketUrl}
							fullWidth
							size="large"
						>
							{neuroLoading ? <CircularProgress size={24} /> : 'Reconnect NeuroClient'}
						</Button>
						<Button
							variant="contained"
							color="secondary"
							onClick={handleDockerReconnect}
							disabled={dockerLoading}
							fullWidth
							size="large"
						>
							{dockerLoading ? <CircularProgress size={24} /> : 'Reconnect Docker Client'}
						</Button>
						<Button
							variant="outlined"
							onClick={refreshStatus}
							disabled={neuroLoading || dockerLoading}
							fullWidth
							size="large"
						>
							Refresh backend status
						</Button>
					</Stack>
				</CardContent>
			</Card>
			<Card sx={{ mt: 2 }}>
				<CardContent>
					<Typography variant="h6" gutterBottom>
						Adaptive Trainer (Teacher + Student)
					</Typography>
					<Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
						Local niche compiler + global gauge transformer status, rollout phase controls, and checkpoint rollback.
					</Typography>
					{adaptiveStatus && (
						<Alert severity="info" sx={{ mb: 2 }}>
							Phase: <strong>{adaptiveStatus.controls.phase}</strong> — Coherence: {adaptiveStatus.gauge.coherence.toFixed(3)} — Drift: {adaptiveStatus.gauge.drift.toFixed(3)} — Interactions: {adaptiveStatus.gauge.totalInteractions}
							<br />
							Update budget: {adaptiveStatus.gauge.updateBudgetUsedLastMinute}/{adaptiveStatus.controls.updateBudgetPerMinute} per minute
							<br />
							Niches: {formatAdaptiveNicheSummary(adaptiveStatus.niches)}
						</Alert>
					)}
					<Stack spacing={2}>
						<TextField
							select
							label="Adaptive phase"
							value={adaptivePhase}
							onChange={(e) => setAdaptivePhase(e.target.value as AdaptivePhase)}
							disabled={adaptivePhaseLoading}
							fullWidth
						>
							<MenuItem value="offline_simulation">offline_simulation</MenuItem>
							<MenuItem value="shadow">shadow</MenuItem>
							<MenuItem value="constrained_action">constrained_action</MenuItem>
							<MenuItem value="gradual_autonomy">gradual_autonomy</MenuItem>
						</TextField>
						<Button
							variant="contained"
							onClick={handleAdaptivePhaseSave}
							disabled={adaptivePhaseLoading}
							fullWidth
						>
							{adaptivePhaseLoading ? <CircularProgress size={24} /> : 'Apply adaptive phase'}
						</Button>
						<Button
							variant="outlined"
							onClick={handleAdaptiveCheckpoint}
							disabled={adaptiveCheckpointLoading}
							fullWidth
						>
							{adaptiveCheckpointLoading ? <CircularProgress size={24} /> : 'Create checkpoint'}
						</Button>
						<Button
							variant="outlined"
							color="warning"
							onClick={handleAdaptiveRollbackLatest}
							disabled={adaptiveCheckpointLoading || !adaptiveStatus?.checkpoints?.length}
							fullWidth
						>
							{adaptiveCheckpointLoading ? <CircularProgress size={24} /> : 'Rollback latest checkpoint'}
						</Button>
						<Button
							variant="outlined"
							onClick={refreshAdaptive}
							disabled={adaptiveLoading || adaptivePhaseLoading || adaptiveCheckpointLoading}
							fullWidth
						>
							{adaptiveLoading ? <CircularProgress size={24} /> : 'Refresh adaptive status'}
						</Button>
					</Stack>
				</CardContent>
			</Card>
		</Box>
	);
}
