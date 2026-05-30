/**
 * hopeOS SDK — Voice Module
 * Whisper speech-to-text with pluggable command registry.
 * Games register their own voice commands without touching SDK internals.
 *
 * Game integration:
 *   import { VoiceCommander } from './interaction/voice.js'
 *   const vc = new VoiceCommander(apiKey, { model: 'gpt-4o-transcribe' });
 *   vc.register('fire', /\b(fire|flame)\b/, () => activateFire());
 *   vc.register('hide', /\b(hide|clear)\b/, () => hideAll());
 *   await vc.start();
 */

export class VoiceCommander {
  constructor(apiKey, opts = {}) {
    this.apiKey = apiKey;
    this.model = opts.model || 'gpt-4o-transcribe';
    this.lang = opts.lang || 'en';
    this.interval = opts.interval || 4000;
    this.active = false;
    this._commands = [];
    this._onTranscript = opts.onTranscript || null;
  }

  /** Register a named voice command with regex pattern and callback */
  register(name, pattern, callback) {
    this._commands.push({ name, pattern, callback });
    return this;
  }

  /** Remove a named command */
  unregister(name) {
    this._commands = this._commands.filter(c => c.name !== name);
  }

  /** Start listening */
  async start() {
    if (!this.apiKey || !this.apiKey.startsWith('sk-')) {
      console.warn('[voice] No valid API key');
      return false;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true }
      });
      this.active = true;
      this._recordLoop(stream);
      return true;
    } catch (e) {
      console.warn('[voice] Mic denied:', e);
      return false;
    }
  }

  stop() { this.active = false; }

  async _transcribe(blob) {
    const fd = new FormData();
    fd.append('file', blob, 'audio.webm');
    fd.append('model', this.model);
    fd.append('language', this.lang);
    try {
      const r = await fetch('https://api.openai.com/v1/audio/transcriptions', {
        method: 'POST',
        headers: { 'Authorization': 'Bearer ' + this.apiKey },
        body: fd
      });
      if (!r.ok) return null;
      return (await r.json()).text || null;
    } catch (e) { return null; }
  }

  _matchCommands(text) {
    const lower = text.toLowerCase().trim();
    if (this._onTranscript) this._onTranscript(lower);
    for (const cmd of this._commands) {
      if (cmd.pattern.test(lower)) {
        cmd.callback(lower);
        return cmd.name;
      }
    }
    return null;
  }

  _recordLoop(stream) {
    if (!this.active) return;
    let busy = false;
    const mimeType = MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
      ? 'audio/webm;codecs=opus' : 'audio/webm';

    const rec = () => {
      if (!this.active || busy) return;
      const chunks = [];
      const mr = new MediaRecorder(stream, { mimeType });
      mr.ondataavailable = e => { if (e.data.size > 0) chunks.push(e.data); };
      mr.onstop = async () => {
        const blob = new Blob(chunks, { type: mimeType });
        if (blob.size < 4000) { next(); return; }
        busy = true;
        const txt = await this._transcribe(blob);
        if (txt && txt.trim().length > 1) this._matchCommands(txt);
        busy = false;
        next();
      };
      mr.start();
      setTimeout(() => { if (mr.state === 'recording') mr.stop(); }, this.interval);
    };

    const next = () => setTimeout(rec, 200);
    rec();
  }
}
