declare module 'facebook-nodejs-business-sdk' {
    export const FacebookAdsApi: {
        init: (accessToken: string) => {
            call: (method: string, path: string, params?: Record<string, unknown>) => Promise<unknown>
        }
    }
}
