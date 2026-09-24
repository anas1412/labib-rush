// Loads the self-hosted fonts (public/fonts/fonts.css) once. Await before drawing canvas text
// (shop signs, taxi signs) so Arabic + Latin glyphs render with the right font.
// Families: 'Cairo' (400–800, UI/body/signage) and 'Baloo Bhaijaan 2' (600–800, playful display).
let loading: Promise<void> | null = null;

export function loadFonts(): Promise<void> {
  if (loading) return loading;
  if (!document.querySelector('link[data-fonts]')) {
    const link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = '/fonts/fonts.css';
    link.dataset.fonts = '';
    document.head.appendChild(link);
  }
  const specs = ['400 16px Cairo', '700 16px Cairo', '800 16px Cairo', '800 16px "Baloo Bhaijaan 2"'];
  loading = new Promise<void>((resolve) => {
    const link = document.querySelector<HTMLLinkElement>('link[data-fonts]')!;
    const go = () =>
      Promise.all(specs.flatMap((s) => [document.fonts.load(s, 'Labib'), document.fonts.load(s, 'لبيب')]))
        .catch(() => undefined)
        .then(() => resolve());
    if (link.sheet) go();
    else link.addEventListener('load', go, { once: true });
    setTimeout(resolve, 4000); // never block the game on fonts
  });
  return loading;
}
