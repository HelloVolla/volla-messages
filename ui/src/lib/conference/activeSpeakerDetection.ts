export interface SpeakerInfo {
  participantId: string;
  audioLevel: number;
  isSpeaking: boolean;
  lastSpokeAt: number;
}

export interface ActiveSpeakerDetectorOptions {
  speakingThreshold?: number;
  switchCooldown?: number;
  sampleInterval?: number;
  smoothingFactor?: number;
  silenceHold?: number;
}

export type LevelProvider = () => Map<string, number>;

export interface LocalLevelMeter {
  getLevel: () => number;
  destroy: () => void;
}

export function createLocalLevelMeter(stream: MediaStream): LocalLevelMeter {
  let audioContext: AudioContext | null = null;
  let analyser: AnalyserNode | null = null;
  let data: Uint8Array | null = null;

  try {
    audioContext = new AudioContext();
    analyser = audioContext.createAnalyser();
    analyser.fftSize = 512;
    analyser.smoothingTimeConstant = 0.2;
    const source = audioContext.createMediaStreamSource(stream);
    source.connect(analyser);
    data = new Uint8Array(analyser.fftSize);
  } catch (e) {
    console.warn("[ActiveSpeaker] local meter setup failed:", e);
  }

  return {
    getLevel(): number {
      const track = stream.getAudioTracks()[0];
      if (!track || !track.enabled || track.readyState === "ended") return 0;
      if (!analyser || !data) return 0;
      analyser.getByteTimeDomainData(data);
      let sum = 0;
      for (let i = 0; i < data.length; i++) {
        const v = (data[i] - 128) / 128;
        sum += v * v;
      }
      return Math.sqrt(sum / data.length);
    },
    destroy() {
      try {
        audioContext?.close();
      } catch {
        void 0;
      }
      audioContext = null;
      analyser = null;
      data = null;
    },
  };
}

export class ActiveSpeakerDetector {
  private levelProvider: LevelProvider | null = null;
  private smoothed = new Map<string, number>();
  private lastSpokeAt = new Map<string, number>();
  private speakingThreshold: number;
  private switchCooldown: number;
  private sampleInterval: number;
  private smoothingFactor: number;
  private silenceHold: number;
  private intervalId: ReturnType<typeof setInterval> | null = null;
  private currentActiveSpeaker: string | null = null;
  private lastSwitchTime = 0;
  private onSpeakerChange: ((speakerId: string | null, all: SpeakerInfo[]) => void) | null = null;

  constructor(options: ActiveSpeakerDetectorOptions = {}) {
    this.speakingThreshold = options.speakingThreshold ?? 0.02;
    this.switchCooldown = options.switchCooldown ?? 400;
    this.sampleInterval = options.sampleInterval ?? 150;
    this.smoothingFactor = options.smoothingFactor ?? 0.4;
    this.silenceHold = options.silenceHold ?? 1000;
  }

  setLevelProvider(provider: LevelProvider): void {
    this.levelProvider = provider;
    this.start();
  }

  onActiveSpeakerChange(cb: (speakerId: string | null, all: SpeakerInfo[]) => void): void {
    this.onSpeakerChange = cb;
  }

  getSpeakerInfo(): SpeakerInfo[] {
    const result: SpeakerInfo[] = [];
    this.smoothed.forEach((level, participantId) => {
      result.push({
        participantId,
        audioLevel: level,
        isSpeaking: level >= this.speakingThreshold,
        lastSpokeAt: this.lastSpokeAt.get(participantId) ?? 0,
      });
    });
    return result;
  }

  private start(): void {
    if (this.intervalId !== null) return;
    this.intervalId = setInterval(() => this.tick(), this.sampleInterval);
  }

  private stop(): void {
    if (this.intervalId !== null) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
  }

  private setActive(id: string | null, now: number): void {
    if (id === this.currentActiveSpeaker) return;
    this.currentActiveSpeaker = id;
    this.lastSwitchTime = now;
    if (this.onSpeakerChange) this.onSpeakerChange(id, this.getSpeakerInfo());
  }

  private tick(): void {
    if (!this.levelProvider) return;
    const now = Date.now();
    const raw = this.levelProvider();

    for (const id of [...this.smoothed.keys()]) {
      if (!raw.has(id)) {
        this.smoothed.delete(id);
        this.lastSpokeAt.delete(id);
        if (this.currentActiveSpeaker === id) this.setActive(null, now);
      }
    }

    let loudestId: string | null = null;
    let loudestLevel = 0;
    for (const [id, level] of raw) {
      const prev = this.smoothed.get(id) ?? 0;
      const s = this.smoothingFactor * level + (1 - this.smoothingFactor) * prev;
      this.smoothed.set(id, s);
      if (s >= this.speakingThreshold) this.lastSpokeAt.set(id, now);
      if (s >= this.speakingThreshold && s > loudestLevel) {
        loudestLevel = s;
        loudestId = id;
      }
    }

    if (loudestId === null) {
      if (this.currentActiveSpeaker !== null) {
        const quietFor = now - (this.lastSpokeAt.get(this.currentActiveSpeaker) ?? 0);
        if (quietFor >= this.silenceHold) this.setActive(null, now);
      }
      return;
    }

    if (loudestId !== this.currentActiveSpeaker) {
      const currentQuietFor =
        this.currentActiveSpeaker !== null
          ? now - (this.lastSpokeAt.get(this.currentActiveSpeaker) ?? 0)
          : Infinity;
      if (
        now - this.lastSwitchTime >= this.switchCooldown ||
        currentQuietFor >= this.switchCooldown
      ) {
        this.setActive(loudestId, now);
      }
    }
  }

  destroy(): void {
    this.stop();
    this.smoothed.clear();
    this.lastSpokeAt.clear();
    this.currentActiveSpeaker = null;
    this.onSpeakerChange = null;
    this.levelProvider = null;
  }
}

export function createActiveSpeakerStore(options?: ActiveSpeakerDetectorOptions) {
  const detector = new ActiveSpeakerDetector(options);
  const subscribers = new Set<
    (value: { activeSpeaker: string | null; speakers: SpeakerInfo[] }) => void
  >();

  let currentValue = {
    activeSpeaker: null as string | null,
    speakers: [] as SpeakerInfo[],
  };

  detector.onActiveSpeakerChange((speakerId, allSpeakers) => {
    currentValue = { activeSpeaker: speakerId, speakers: allSpeakers };
    subscribers.forEach((fn) => fn(currentValue));
  });

  return {
    subscribe(fn: (value: typeof currentValue) => void) {
      subscribers.add(fn);
      fn(currentValue);
      return () => subscribers.delete(fn);
    },
    setLevelProvider: detector.setLevelProvider.bind(detector),
    destroy: detector.destroy.bind(detector),
  };
}
