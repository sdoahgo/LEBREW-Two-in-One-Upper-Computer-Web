// Firmware payload throughput. Retries and packet padding are not extra progress.
export class OtaTransferRate {
  constructor(totalBytes, clock = () => performance.now()) {
    this.clock = clock;
    this.totalBytes = totalBytes;
    this.startedAt = this.lastNow = clock();
    this.sent = 0;
    this.samples = [{ time:this.startedAt, sent:0 }];
    this.active = true;
    this.simulated = false;
  }

  now() {
    this.lastNow = Math.max(this.lastNow, this.clock());
    return this.lastNow;
  }

  update(sent) {
    if (!this.active || !Number.isFinite(sent)) return;
    const time = this.now();
    this.sent = Math.max(this.sent, Math.min(this.totalBytes, Math.max(0, sent)));
    this.samples.push({time, sent:this.sent});
    this.prune(time);
  }

  prune(time) {
    const cutoff = time - 1500;
    while (this.samples.length > 2 && this.samples[1].time <= cutoff) this.samples.shift();
  }

  snapshot() {
    const time = this.active ? this.now() : this.endedAt;
    this.prune(time);
    const elapsedMs = Math.max(0, time-this.startedAt);
    const cutoff = Math.max(this.startedAt, time-1500);
    let baseline = this.samples[0].sent;
    for (let i=0; i<this.samples.length; i++) {
      const a=this.samples[i], b=this.samples[i+1];
      if (a.time > cutoff) break;
      baseline=a.sent;
      if (b && b.time>cutoff && b.time>a.time) {
        baseline+=(b.sent-a.sent)*(cutoff-a.time)/(b.time-a.time);
        break;
      }
    }
    const windowMs=time-cutoff;
    return {sent:this.sent, totalBytes:this.totalBytes, elapsedMs,
      currentBps:this.active && windowMs>0 ? Math.max(0,(this.sent-baseline)*1000/windowMs) : 0,
      averageBps:elapsedMs>0 ? this.sent*1000/elapsedMs : 0,
      finished:!this.active, simulated:this.simulated};
  }

  stop() {
    if (this.active) { this.endedAt=this.now(); this.active=false; }
    return this.snapshot();
  }
}

export function formatTransferRate(bytesPerSecond) {
  if (!Number.isFinite(bytesPerSecond) || bytesPerSecond<0) return '--';
  if (bytesPerSecond>=1024*1024) return (bytesPerSecond/(1024*1024)).toFixed(2)+' MB/s';
  if (bytesPerSecond>=1024) return (bytesPerSecond/1024).toFixed(1)+' KB/s';
  return Math.round(bytesPerSecond)+' B/s';
}
