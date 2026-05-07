/**
 * Miro app entry point (loaded from index.html when the app is running on a board).
 * Registers `icon:click` → `openPanel({ url: 'app.html' })` for the side panel.
 * The panel’s "Create new org chart" button (in app.html / src/app.js) opens `create-chart.html` as a modal.
 */
export async function init() {
    miro.board.ui.on('icon:click', async () => {
        await miro.board.ui.openPanel({ url: 'app.html' });
    });
}

init();
