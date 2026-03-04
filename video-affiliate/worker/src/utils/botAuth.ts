export function getBotId(token: string): string {
    if (!token) return 'default';
    const parts = token.split(':');
    return parts[0] || 'default';
}
