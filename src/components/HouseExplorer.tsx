import { useEffect, useRef, useState } from 'react';
import { House } from 'lucide-react';
import { createHouseModel } from './house-model';

export default function HouseExplorer() {
  const host = useRef<HTMLDivElement>(null);
  const [unavailable, setUnavailable] = useState(false);
  useEffect(() => {
    if (!host.current) return;
    try {
      const model = createHouseModel(host.current);
      return () => model.dispose();
    } catch { setUnavailable(true); }
  }, []);
  return <section className="house-explorer" aria-label="Explore the house">
    <div className="house-viewer">
      <div ref={host} className="house-canvas" tabIndex={0} role="group" aria-label="Interactive 3D house. Drag to rotate and reveal the interior. Arrow keys rotate; Enter opens or closes the house; Home resets the view." />
      {unavailable && <div className="house-fallback"><House size={110} strokeWidth={0.8} /><span>The 3D view is unavailable in this browser.</span></div>}
    </div>
  </section>;
}
