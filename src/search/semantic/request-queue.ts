/**
 * Request queue for rate limiting Ollama API calls
 */

export class RequestQueue {
  private queue: Array<() => Promise<any>> = [];
  private activeRequests = 0;
  private maxConcurrent: number;

  constructor(maxConcurrent = 3) {
    this.maxConcurrent = maxConcurrent;
  }

  async add<T>(request: () => Promise<T>): Promise<T> {
    return new Promise((resolve, reject) => {
      this.queue.push(async () => {
        try {
          this.activeRequests++;
          const result = await request();
          resolve(result);
        } catch (error) {
          reject(error);
        } finally {
          this.activeRequests--;
          this.processNext();
        }
      });
    
      this.processNext();
    });
  }

  private processNext(): void {
    if (this.queue.length > 0 && this.activeRequests < this.maxConcurrent) {
      const request = this.queue.shift()!;
      request();
    }
  }

  getQueueSize(): number {
    return this.queue.length;
  }

  getActiveRequests(): number {
    return this.activeRequests;
  }

  clear(): void {
    this.queue = [];
  }

  updateConcurrentLimit(newLimit: number): void {
    this.maxConcurrent = newLimit;
    // Process any queued requests that can now run
    this.processNext();
  }
}
