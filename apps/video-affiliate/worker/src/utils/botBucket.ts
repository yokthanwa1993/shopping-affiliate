export class BotBucket {
    constructor(private bucket: R2Bucket, private botId: string) { }

    private prepend(key: string): string {
        if (this.botId === 'default') return key;
        return `${this.botId}/${key}`;
    }

    private strip(key: string): string {
        if (this.botId === 'default') return key;
        if (key.startsWith(`${this.botId}/`)) {
            return key.slice(this.botId.length + 1);
        }
        return key;
    }

    async get(key: string, options?: R2GetOptions): Promise<R2ObjectBody | null> {
        return this.bucket.get(this.prepend(key), options);
    }

    async head(key: string): Promise<R2Object | null> {
        return this.bucket.head(this.prepend(key));
    }

    async put(key: string, value: any, options?: R2PutOptions): Promise<R2Object | null> {
        return this.bucket.put(this.prepend(key), value, options);
    }

    async delete(keys: string | string[]): Promise<void> {
        if (Array.isArray(keys)) {
            await this.bucket.delete(keys.map(k => this.prepend(k)));
        } else {
            await this.bucket.delete(this.prepend(keys));
        }
    }

    async list(options?: R2ListOptions): Promise<R2Objects> {
        let prefix = options?.prefix;
        if (this.botId !== 'default') {
            prefix = options?.prefix ? this.prepend(options.prefix) : `${this.botId}/`;
        }
        const res = await this.bucket.list({ ...options, prefix });

        // Strip the botId from the returned keys so the rest of the app doesn't know
        return {
            ...res,
            objects: res.objects.map(obj => ({
                ...obj,
                key: this.strip(obj.key)
            }))
        } as R2Objects;
    }

    async createMultipartUpload(key: string, options?: R2MultipartOptions): Promise<R2MultipartUpload> {
        return this.bucket.createMultipartUpload(this.prepend(key), options);
    }

    resumeMultipartUpload(key: string, uploadId: string): R2MultipartUpload {
        return this.bucket.resumeMultipartUpload(this.prepend(key), uploadId);
    }
}
