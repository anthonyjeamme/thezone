type MusicTrack = {
    name: string;
    path: string;
};

const MUSIC_TRACKS: MusicTrack[] = [
    { name: 'Forest of Small Wonders - 1', path: '/sounds/musics/Forest of Small Wonders - 1.mp3' },
    { name: 'Forest of Small Wonders - 2', path: '/sounds/musics/Forest of Small Wonders - 2.mp3' },
    { name: 'Thornwind Glade - 1', path: '/sounds/musics/Thornwind Glade - 1.mp3' },
    { name: 'Thornwind Glade - 2', path: '/sounds/musics/Thornwind Glade - 2.mp3' },
    { name: 'Whispers of the Hearth - 1', path: '/sounds/musics/Whispers of the Hearth - 1.mp3' },
    { name: 'Whispers of the Hearth - 2', path: '/sounds/musics/Whispers of the Hearth - 2.mp3' },
];

const FADE_DURATION = 2;
const CROSSFADE_START = 3;

export class MusicManager {
    private currentAudio: HTMLAudioElement | null = null;
    private nextAudio: HTMLAudioElement | null = null;
    private currentTrackIndex = -1;
    private volume = 0.15;
    private targetVolume = 0;
    private currentVolume = 0;
    private enabled = false;
    private started = false;
    private playlist: MusicTrack[] = [];
    private fadeTimer = 0;
    private isCrossfading = false;

    constructor() {
        this.shufflePlaylist();
    }

    private shufflePlaylist(): void {
        this.playlist = [...MUSIC_TRACKS].sort(() => Math.random() - 0.5);
    }

    setVolume(vol: number): void {
        this.volume = Math.max(0, Math.min(1, vol));
    }

    setEnabled(enabled: boolean): void {
        if (this.enabled === enabled) return;
        this.enabled = enabled;
        this.targetVolume = enabled ? this.volume : 0;

        if (enabled && !this.started) {
            this.start();
        }
    }

    private start(): void {
        if (this.started) return;
        this.started = true;
        this.playNext();
    }

    private playNext(): void {
        if (!this.enabled || this.playlist.length === 0) return;

        this.currentTrackIndex = (this.currentTrackIndex + 1) % this.playlist.length;

        if (this.currentTrackIndex === 0) {
            this.shufflePlaylist();
        }

        const track = this.playlist[this.currentTrackIndex];

        if (this.currentAudio) {
            this.currentAudio.pause();
            this.currentAudio.src = '';
        }

        this.currentAudio = new Audio(track.path);
        this.currentAudio.volume = this.currentVolume;
        this.currentAudio.preload = 'auto';

        this.currentAudio.addEventListener('ended', () => {
            this.playNext();
        });

        this.currentAudio.addEventListener('canplaythrough', () => {
            if (this.enabled) {
                this.currentAudio?.play().catch(() => { });
            }
        }, { once: true });

        this.currentAudio.load();

        const nextIndex = (this.currentTrackIndex + 1) % this.playlist.length;
        const nextTrack = this.playlist[nextIndex];
        this.nextAudio = new Audio(nextTrack.path);
        this.nextAudio.preload = 'auto';
        this.nextAudio.load();
    }

    update(dt: number): void {
        if (!this.started) return;

        const fadeSpeed = 0.5;
        if (this.currentVolume < this.targetVolume) {
            this.currentVolume = Math.min(this.targetVolume, this.currentVolume + fadeSpeed * dt);
        } else if (this.currentVolume > this.targetVolume) {
            this.currentVolume = Math.max(this.targetVolume, this.currentVolume - fadeSpeed * dt);
        }

        if (this.currentAudio) {
            this.currentAudio.volume = Math.max(0, Math.min(1, this.currentVolume));

            if (this.enabled && this.currentVolume > 0.01 && this.currentAudio.paused) {
                this.currentAudio.play().catch(() => { });
            } else if ((!this.enabled || this.currentVolume <= 0.01) && !this.currentAudio.paused) {
                this.currentAudio.pause();
            }

            if (!this.currentAudio.paused) {
                const timeRemaining = this.currentAudio.duration - this.currentAudio.currentTime;
                if (timeRemaining > 0 && timeRemaining < CROSSFADE_START && !this.isCrossfading) {
                    this.startCrossfade();
                }
            }
        }

        if (this.isCrossfading && this.nextAudio) {
            this.fadeTimer += dt;
            const progress = Math.min(1, this.fadeTimer / FADE_DURATION);

            if (this.currentAudio) {
                this.currentAudio.volume = this.currentVolume * (1 - progress);
            }
            this.nextAudio.volume = this.currentVolume * progress;

            if (progress >= 1) {
                if (this.currentAudio) {
                    this.currentAudio.pause();
                    this.currentAudio.src = '';
                }
                this.currentAudio = this.nextAudio;
                this.nextAudio = null;
                this.isCrossfading = false;
                this.fadeTimer = 0;

                const nextIndex = (this.currentTrackIndex + 1) % this.playlist.length;
                const nextTrack = this.playlist[nextIndex];
                this.nextAudio = new Audio(nextTrack.path);
                this.nextAudio.preload = 'auto';
                this.nextAudio.load();
            }
        }
    }

    private startCrossfade(): void {
        if (this.isCrossfading || !this.nextAudio || !this.currentAudio) return;

        this.isCrossfading = true;
        this.fadeTimer = 0;

        this.nextAudio.currentTime = 0;
        this.nextAudio.volume = 0;
        this.nextAudio.play().catch(() => { });

        this.currentTrackIndex = (this.currentTrackIndex + 1) % this.playlist.length;
        if (this.currentTrackIndex === 0) {
            this.shufflePlaylist();
        }
    }

    destroy(): void {
        if (this.currentAudio) {
            this.currentAudio.pause();
            this.currentAudio.src = '';
        }
        if (this.nextAudio) {
            this.nextAudio.pause();
            this.nextAudio.src = '';
        }
        this.currentAudio = null;
        this.nextAudio = null;
        this.started = false;
        this.enabled = false;
    }
}
