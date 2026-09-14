/**
 * Object access with optimistic concurrency. Every write either replaces the
 * revision the caller read (`If-Match: <etag>`) or creates an absent object
 * (`If-None-Match: *`), so a machine that read a stale document is refused
 * instead of silently overwriting another machine's write.
 *
 * @module dsh-oss-sync/store
 */
import { GetObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { defaultProvider } from '@aws-sdk/credential-provider-node';
/** Raised when the object moved after the revision the caller read. */
export class PreconditionFailedError extends Error {
    constructor(key) {
        super(`dsh-oss-sync: "${key}" changed since it was read; re-read and retry`);
        this.name = 'PreconditionFailedError';
    }
}
/** Whether an SDK failure means the object is absent rather than unreachable. */
function isMissingObject(error) {
    const candidate = error;
    return candidate?.name === 'NoSuchKey' || candidate?.name === 'NotFound'
        || candidate?.$metadata?.httpStatusCode === 404;
}
/** Whether an SDK failure is the service refusing a stale precondition. */
function isPreconditionFailed(error) {
    const candidate = error;
    return candidate?.name === 'PreconditionFailed' || candidate?.$metadata?.httpStatusCode === 412;
}
/** Static credentials when the plugin's own variables are set; otherwise the SDK chain. */
function resolveStaticCredentials(config) {
    const accessKeyId = process.env[config.accessKeyIdEnv];
    const secretAccessKey = process.env[config.secretAccessKeyEnv];
    if (accessKeyId === undefined || accessKeyId.length === 0)
        return undefined;
    if (secretAccessKey === undefined || secretAccessKey.length === 0) {
        throw new Error(`dsh-oss-sync: ${config.accessKeyIdEnv} is set but ${config.secretAccessKeyEnv} is not`);
    }
    return { accessKeyId, secretAccessKey };
}
/** One bucket, reached through the S3 API. */
export class ObjectStore {
    config;
    client;
    /**
     * The SDK's own credential chain, present only when the plugin's variables
     * are unset. It resolves lazily per request, so the first request would
     * otherwise fail with the SDK's own message from inside an unrelated write;
     * {@link ObjectStore.preflight} resolves it once, at load.
     */
    ambient;
    constructor(config) {
        this.config = config;
        const staticCredentials = resolveStaticCredentials(config);
        this.ambient = staticCredentials === undefined ? defaultProvider() : undefined;
        const clientConfig = {
            region: config.region,
            forcePathStyle: config.forcePathStyle,
            ...config.endpoint === undefined ? {} : { endpoint: config.endpoint },
            ...staticCredentials === undefined ? {} : { credentials: staticCredentials },
        };
        this.client = new S3Client(clientConfig);
    }
    /**
     * Resolve the ambient credential chain once, so a host with no credentials
     * fails at load with the variables it should set instead of failing inside
     * whichever write reaches storage first.
     * @throws {Error} naming the variables that are missing.
     */
    async preflight() {
        if (this.ambient === undefined)
            return;
        try {
            await this.ambient();
        }
        catch (error) {
            throw new Error(`dsh-oss-sync: no credentials for bucket "${this.config.bucket}"; set ${this.config.accessKeyIdEnv} and`
                + ` ${this.config.secretAccessKeyEnv}, or configure the AWS SDK chain (AWS_ACCESS_KEY_ID, a profile, or an`
                + ` instance role): ${String(error)}`);
        }
    }
    /**
     * Read one object.
     * @param key - object key inside the configured bucket.
     * @returns the text and ETag, or `undefined` while the object does not exist.
     * @throws when the service is unreachable or refuses the request.
     */
    async read(key) {
        try {
            const response = await this.client.send(new GetObjectCommand({ Bucket: this.config.bucket, Key: key }));
            const text = await response.Body?.transformToString() ?? '';
            return { text, etag: response.ETag ?? '' };
        }
        catch (error) {
            if (isMissingObject(error))
                return undefined;
            throw error;
        }
    }
    /**
     * Write one object under a precondition.
     * @param key - object key inside the configured bucket.
     * @param text - the object's complete next text.
     * @param condition - the precondition the write presents.
     * @returns the new object's ETag.
     * @throws {PreconditionFailedError} when the service refused the precondition.
     */
    async write(key, text, condition) {
        try {
            const response = await this.client.send(new PutObjectCommand({
                Bucket: this.config.bucket,
                Key: key,
                Body: text,
                ContentType: 'application/yaml; charset=utf-8',
                ...condition.ifMatch === undefined ? {} : { IfMatch: condition.ifMatch },
                ...condition.ifNoneMatch === true ? { IfNoneMatch: '*' } : {},
            }));
            return { etag: response.ETag ?? '' };
        }
        catch (error) {
            if (isPreconditionFailed(error))
                throw new PreconditionFailedError(key);
            throw error;
        }
    }
    /** Release the HTTP agent held by the SDK client. */
    destroy() {
        this.client.destroy();
    }
}
