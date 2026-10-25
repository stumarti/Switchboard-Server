// Drawing for a TV rather than an e-ink panel: photos in full colour at the
// screen's resolution (`scale` times the layout's pixels), each one fading in
// over the last, those whose layout asks for it slowly zooming and drifting,
// and no battery in the footer. The display page (public/app/display.js)
// turns it on for the whole page; the admin preview's TV size for its own
// panel (TvContext).
import { createContext } from 'preact';
import { useContext } from 'preact/hooks';

export const display = { tv: false, scale: 1 };
export const TvContext = createContext(false);
export const useTv = () => useContext(TvContext) || display.tv;
