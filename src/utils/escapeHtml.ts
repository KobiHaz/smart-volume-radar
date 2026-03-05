/**
 * Smart Volume Radar - HTML escaping for user/API content in Telegram
 * Prevents XSS when embedding user content in HTML.
 */
export function escapeHtml(text: string): string {
    if (!text) return '';
    return text
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');
}
