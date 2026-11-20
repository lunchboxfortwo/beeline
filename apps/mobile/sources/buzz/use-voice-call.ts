import { appErrorCopy } from '@/buzz/app-error-copy';
import * as React from 'react';
import { AppState, Platform } from 'react-native';
import type { Room } from './voice-transport';
import { activateKeepAwakeAsync, deactivateKeepAwake } from 'expo-keep-awake';
import {
  VOICE_DATA_TOPIC,
  type VoiceBudget,
  type VoiceJoin,
  type VoiceSignal,
  type VoiceCall,
  type RoomViewIdentity,
} from '@beeline/api-contract/phone';
import { monolithPhoneOperation } from '@/sync/transport/monolith-operation';
import {
  createVoiceRoom,
  loadVoiceClient,
  subscribeVoiceMicrophone,
  subscribeVoiceResume,
} from './voice-transport';
import { reportClientError } from './client-error-report';
import { sharedLiveConnection } from '@/sync/transport/live-connection';
import { voiceWaveformLevel } from './waveform-level';

function dailyLimitMessage(budget: VoiceBudget): string {
  return `Calls resume at ${new Date(budget.resetAt).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true, timeZone: budget.timeZone })}`;
}

async function closeVoiceTransport(
  transport: { room: Room; closeAudio(): Promise<void> } | undefined | null,
) {
  if (!transport) return;
  // Stop RTC before releasing its native audio session; each cleanup is best effort.
  for (const close of [() => transport.room.disconnect(), () => transport.closeAudio()]) {
    try {
      await close();
    } catch (cause) {
      void reportClientError('voice-cleanup', cause);
    }
  }
}

const NO_AGENTS: readonly RoomViewIdentity[] = [];

const KEEP_AWAKE_TAG = 'conversation-mode';
// Run screen-wake changes in call order: a release must not overtake the next call's hold.
let keepAwakeQueue = Promise.resolve();
function queueKeepAwake(change: (tag: string) => Promise<void>) {
  keepAwakeQueue = keepAwakeQueue.then(() => change(KEEP_AWAKE_TAG)).catch(() => {});
}

export function useVoiceCall(
  roomId: string,
  enabled: boolean,
  roomAgents: readonly RoomViewIdentity[] = NO_AGENTS,
) {
  const [endingSeconds, setEndingSeconds] = React.useState<number | null>(null);
  const [call, setCall] = React.useState<VoiceCall | null>(null);
  const [joinedAgents, setJoinedAgents] = React.useState<{
    roomId: string;
    agents: readonly RoomViewIdentity[];
  } | null>(null);
  const agents = joinedAgents?.roomId === roomId ? joinedAgents.agents : roomAgents;
  const [target, setTarget] = React.useState<string | null>(null);
  const [speaker, setSpeaker] = React.useState<string | null>(null);
  const [level, setLevel] = React.useState(0);
  const [muted, setMuted] = React.useState(false);
  const mutedRef = React.useRef(false);
  const mutePending = React.useRef(false);
  const [connecting, setConnecting] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const transientReplyError = React.useRef(false);
  const [quotaExhausted, setQuotaExhausted] = React.useState(false);
  const quotaRef = React.useRef(false);
  const [budgetWarning, setBudgetWarning] = React.useState<string | null>(null);
  const [firstAudioMs, setFirstAudioMs] = React.useState<number | null>(null);
  const session = React.useRef<{
    room: Room;
    callId: string;
    sessionId: string;
    closeAudio(): Promise<void>;
  } | null>(null);
  const revision = React.useRef(0);
  const pending = React.useRef(false);
  const speakerRef = React.useRef<string | null>(null);
  const targetRef = React.useRef<string | null>(null);
  const mode = React.useRef<'active' | 'ended'>('ended');
  const liveCleanup = React.useRef<(() => void) | null>(null);
  const joiningCleanup = React.useRef<(() => Promise<void>) | null>(null);

  const end = React.useCallback(async () => {
    revision.current++;
    mode.current = 'ended';
    setBudgetWarning(null);
    liveCleanup.current?.();
    liveCleanup.current = null;
    const current = session.current;
    session.current = null;
    const cancelJoin = joiningCleanup.current;
    joiningCleanup.current = null;
    mutedRef.current = false;
    setMuted(false);
    setEndingSeconds(null);
    setCall(null);
    setSpeaker(null);
    setLevel(0);
    setConnecting(false);
    setError(null);
    transientReplyError.current = false;
    setJoinedAgents(null);
    setTarget(null);
    targetRef.current = null;
    speakerRef.current = null;
    if (cancelJoin) await cancelJoin();
    if (!current) return;
    await closeVoiceTransport(current);
    try {
      await monolithPhoneOperation('voiceLeave', {
        callId: current.callId,
        sessionId: current.sessionId,
      });
    } catch {
      /* RTC disconnect also removes the participant server-side. */
    }
  }, []);
  React.useEffect(
    () => () => {
      void end();
    },
    [roomId, end],
  );
  React.useEffect(() => {
    if (!enabled) void end();
  }, [enabled, end]);
  // Load LiveKit with the call-capable screen, not on the tap: an await before startAudio loses Safari's user activation.
  React.useEffect(() => {
    if (enabled) void loadVoiceClient().catch(() => {});
  }, [enabled]);
  // Keep the screen on only while a call runs; every end path clears `call` or unmounts.
  const callActive = call !== null;
  React.useEffect(() => {
    if (!callActive) return;
    queueKeepAwake(activateKeepAwakeAsync);
    return () => queueKeepAwake(deactivateKeepAwake);
  }, [callActive]);
  // Calls run only in the foreground on phones. `inactive` (iOS control center, system sheets) keeps the call.
  const callStarted = callActive || connecting;
  React.useEffect(() => {
    if (!callStarted || Platform.OS === 'web') return;
    const subscription = AppState.addEventListener('change', (state) => {
      if (state === 'background') void end();
    });
    return () => subscription.remove();
  }, [callStarted, end]);

  const join = React.useCallback(async () => {
    if (session.current || pending.current) return;
    if (!enabled) {
      setError('You cannot join Conversation mode in this chat.');
      return;
    }
    pending.current = true;
    const version = ++revision.current;
    setConnecting(true);
    setError(null);
    transientReplyError.current = false;
    setQuotaExhausted(false);
    quotaRef.current = false;
    let transport: Awaited<ReturnType<typeof createVoiceRoom>> | undefined;
    let joined: VoiceJoin | undefined;
    let closing: Promise<void> | undefined;
    const release = () => (closing ??= closeVoiceTransport(transport));
    const current = () => version === revision.current;
    try {
      transport = await createVoiceRoom(() => {
        void end();
      }, roomId);
      const { RoomEvent, Track } = await loadVoiceClient();
      joiningCleanup.current = release;
      if (version !== revision.current) {
        await release();
        return;
      }
      joined = await monolithPhoneOperation('voiceJoin', { roomId });
      if (version !== revision.current) {
        await release();
        await monolithPhoneOperation('voiceLeave', {
          callId: joined.call.id,
          sessionId: joined.sessionId,
        });
        return;
      }
      await transport.configureStop(joined.call.id, joined.stopToken);
      if (version !== revision.current) {
        await release();
        await monolithPhoneOperation('voiceLeave', {
          callId: joined.call.id,
          sessionId: joined.sessionId,
        });
        return;
      }
      setJoinedAgents({ roomId, agents: joined.agents });
      const { room } = transport;
      const restoreTarget = async () => {
        if (current() && targetRef.current)
          await room.localParticipant.publishData(
            new TextEncoder().encode(
              JSON.stringify({ type: 'target', agentId: targetRef.current, tap: true }),
            ),
            { reliable: true, topic: VOICE_DATA_TOPIC },
          );
      };
      room.on(RoomEvent.ParticipantConnected, (participant) => {
        if (participant.identity === `beeline-voice-${joined!.call.id}`)
          void restoreTarget().catch(() => {});
      });
      const stopMeter = subscribeVoiceMicrophone(room, (amplitude) => {
        if (current()) setLevel(quotaRef.current ? 0 : voiceWaveformLevel(amplitude));
      });
      const closeAudio = transport.closeAudio;
      transport.closeAudio = async () => {
        stopMeter();
        await closeAudio();
      };
      let microphonePublished = false;
      let reconnecting: Promise<void> | undefined;
      const updateReadiness = () => {
        if (current()) setConnecting(!microphonePublished || !room.canPlaybackAudio);
      };
      room.on(RoomEvent.AudioPlaybackStatusChanged, updateReadiness);
      mode.current = 'active';
      room.on(RoomEvent.DataReceived, (bytes, participant, _kind, topic) => {
        if (
          version !== revision.current ||
          topic !== VOICE_DATA_TOPIC ||
          participant?.identity !== `beeline-voice-${joined!.call.id}`
        )
          return;
        try {
          const data = JSON.parse(new TextDecoder().decode(bytes)) as VoiceSignal;
          if (data.type === 'budget') {
            const budget: VoiceBudget = data.budget;
            if (
              !budget ||
              !Number.isFinite(budget.remainingMs) ||
              budget.remainingMs < 0 ||
              !Number.isFinite(budget.resetAt) ||
              budget.timeZone !== 'UTC'
            )
              return;
            if (budget.remainingMs === 0) {
              // Fence reconnection before the server removes this RTC participant.
              const message = dailyLimitMessage(budget);
              const endedVersion = revision.current + 1;
              void end().then(() => {
                if (revision.current === endedVersion) setError(message);
              });
              return;
            }
            if (budget.remainingMs > 120_000) {
              setBudgetWarning(null);
              return;
            }
            setBudgetWarning(
              budget.remainingMs >= 60_000
                ? `${Math.ceil(budget.remainingMs / 60_000)} min left today`
                : `${Math.ceil(budget.remainingMs / 1000)}s left today`,
            );
            return;
          }
          if (data.type === 'stop') {
            void end();
            return;
          }
          if (data.type === 'ending') {
            if (data.deadline === null) setEndingSeconds(null);
            else if (Number.isFinite(data.deadline) && Number.isFinite(data.serverNow))
              setEndingSeconds(Math.max(0, Math.ceil((data.deadline - data.serverNow) / 1000)));
          }
          if (data.type === 'speaker') {
            speakerRef.current = data.agentId;
            setSpeaker(data.agentId);
            if (transientReplyError.current) {
              transientReplyError.current = false;
              setError(null);
            }
          }
          // Routing notifications describe speech, not this person's explicit pin.
          if (data.type === 'error') {
            setError(data.message);
            if (data.code === 'speech-quota-exhausted') {
              transientReplyError.current = false;
              quotaRef.current = true;
              setQuotaExhausted(true);
              setLevel(0);
              void room.localParticipant.setMicrophoneEnabled(false).catch(() => {});
            } else transientReplyError.current = true;
          }
          if (data.type === 'latency') setFirstAudioMs(data.firstAudioMs);
        } catch {}
      });
      if (Platform.OS === 'web') {
        room.on(RoomEvent.TrackSubscribed, (track) => {
          if (track.kind !== Track.Kind.Audio) return;
          const element = track.attach();
          element.dataset.beelineVoiceAudio = joined!.call.id;
          element.style.display = 'none';
          document.body.appendChild(element);
        });
        room.on(RoomEvent.TrackUnsubscribed, (track) =>
          track.detach().forEach((el) => el.remove()),
        );
      }
      room.on(RoomEvent.Disconnected, () => {
        if (
          version !== revision.current ||
          mode.current !== 'active' ||
          session.current?.room !== room
        )
          return;
        if (reconnecting) return;
        setConnecting(true);
        // A lost transport does not mean the human left. Rejoin this call once;
        // the expected id prevents a committed end from starting another call.
        reconnecting = (async () => {
          const replacement = await monolithPhoneOperation('voiceJoin', {
            roomId,
            expectedCallId: joined!.call.id,
          });
          if (!current()) {
            await monolithPhoneOperation('voiceLeave', {
              callId: replacement.call.id,
              sessionId: replacement.sessionId,
            });
            return;
          }
          joined = replacement;
          session.current = {
            ...transport!,
            callId: replacement.call.id,
            sessionId: replacement.sessionId,
          };
          await transport!.configureStop(replacement.call.id, replacement.stopToken);
          if (!current()) return;
          await room.connect(replacement.url, replacement.token, { maxRetries: 0 });
          if (!current()) {
            await closeVoiceTransport(transport);
            return;
          }
          await room.startAudio();
          await room.localParticipant.setMicrophoneEnabled(!mutedRef.current && !quotaRef.current, {
            echoCancellation: true,
            noiseSuppression: true,
            autoGainControl: false,
          });
          if (!current()) return;
          setCall(replacement.call);
          setError(null);
          updateReadiness();
          await restoreTarget();
        })()
          .catch((cause) => {
            if (current()) {
              setConnecting(false);
              setError(appErrorCopy(cause, 'Conversation mode disconnected.'));
            }
            reconcileAgain = true;
          })
          .finally(() => {
            reconnecting = undefined;
            if (reconcileAgain) {
              reconcileAgain = false;
              reconcile();
            }
          });
      });
      await room.connect(joined.url, joined.token, { maxRetries: 0 });
      if (version !== revision.current) {
        await release();
        await monolithPhoneOperation('voiceLeave', {
          callId: joined.call.id,
          sessionId: joined.sessionId,
        });
        return;
      }
      const playbackReady = room.startAudio();
      const defaultTarget = joined.agents.find((a) => a.pubkey === targetRef.current)?.pubkey;
      if (defaultTarget)
        await room.localParticipant.publishData(
          new TextEncoder().encode(
            JSON.stringify({ type: 'target', agentId: defaultTarget, tap: true }),
          ),
          { reliable: true, topic: VOICE_DATA_TOPIC },
        );
      await room.localParticipant.setMicrophoneEnabled(true, {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: false,
      });
      microphonePublished = true;
      await playbackReady;
      updateReadiness();
      if (quotaRef.current) await room.localParticipant.setMicrophoneEnabled(false);
      if (version !== revision.current) {
        await release();
        await monolithPhoneOperation('voiceLeave', {
          callId: joined.call.id,
          sessionId: joined.sessionId,
        });
        return;
      }
      joiningCleanup.current = null;
      session.current = { ...transport, callId: joined.call.id, sessionId: joined.sessionId };
      setCall(joined.call);
      setTarget(defaultTarget ?? null);
      targetRef.current = defaultTarget ?? null;
      const live = sharedLiveConnection();
      let reconciling: Promise<void> | undefined;
      let reconcileAgain = false;
      const reconcile = () => {
        const active = joined!;
        if (!current() || reconciling || reconnecting) return;
        reconciling = monolithPhoneOperation('voiceState', {
          callId: active.call.id,
          sessionId: active.sessionId,
        })
          .then((state) => {
            if (current() && joined === active && state.state === 'ended') {
              void end();
            }
          })
          .catch(() => {})
          .finally(() => {
            reconciling = undefined;
            if (reconcileAgain) {
              reconcileAgain = false;
              reconcile();
            }
          });
      };
      const dispose = await live.register([{ '#h': [roomId] }], () => {
        // A new committed event still needs coverage if it arrived during the read.
        if (reconciling || reconnecting) reconcileAgain = true;
        else reconcile();
      });
      if (!current()) {
        dispose();
        return;
      }
      const disconnectListener = live.subscribeConnected(() => {
        if (reconnecting) reconcileAgain = true;
        else reconcile();
      });
      liveCleanup.current = () => {
        dispose();
        disconnectListener();
      };
    } catch (cause) {
      if (version === revision.current) void reportClientError('voice-join', cause);
      await release();
      if (joined)
        await monolithPhoneOperation('voiceLeave', {
          callId: joined.call.id,
          sessionId: joined.sessionId,
        }).catch(() => {});
      if (version === revision.current) {
        const endedVersion = revision.current + 1;
        await end();
        if (revision.current !== endedVersion) return;
        const name = cause && typeof cause === 'object' && 'name' in cause ? cause.name : '';
        setError(
          name === 'NotFoundError'
            ? 'No microphone was found.'
            : name === 'NotAllowedError'
              ? 'Microphone access is blocked.'
              : appErrorCopy(cause, 'Conversation mode could not start') ||
                'Conversation mode could not start',
        );
      }
    } finally {
      if (joiningCleanup.current === release) joiningCleanup.current = null;
      pending.current = false;
    }
  }, [enabled, roomId, end]);
  React.useEffect(() => {
    if (!enabled) return;
    return subscribeVoiceResume(roomId, () => {
      void join();
    });
  }, [enabled, roomId, join]);
  const aim = React.useCallback(
    (agentId: string) => {
      if (!agents.some((a) => a.pubkey === agentId)) return;
      const next = targetRef.current === agentId ? null : agentId;
      setTarget(next);
      targetRef.current = next;
      void session.current?.room.localParticipant.publishData(
        new TextEncoder().encode(
          JSON.stringify(next ? { type: 'target', agentId: next, tap: true } : { type: 'unpin' }),
        ),
        { reliable: true, topic: VOICE_DATA_TOPIC },
      );
    },
    [agents],
  );
  const toggleMute = React.useCallback(async () => {
    const current = session.current;
    if (!current || mutePending.current || quotaRef.current) return;
    mutePending.current = true;
    const next = !mutedRef.current;
    try {
      await current.room.localParticipant.setMicrophoneEnabled(!next);
      if (session.current === current) {
        mutedRef.current = next;
        setMuted(next);
      }
    } catch (cause) {
      void reportClientError('voice-join', cause);
    } finally {
      mutePending.current = false;
    }
  }, []);
  return {
    budgetWarning,
    muted,
    toggleMute,
    endingWarning: endingSeconds === null ? undefined : `Ending in ${endingSeconds}s`,
    call,
    agents,
    target,
    speaker,
    level,
    connecting,
    error,
    quotaExhausted,
    firstAudioMs,
    join,
    end,
    aim,
  };
}

export type VoiceCallState = ReturnType<typeof useVoiceCall>;
