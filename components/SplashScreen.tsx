import React, { useState } from 'react';
import { Heart, Github } from 'lucide-react';
import logo from '../assets/voxshop_logo.png?url';

interface SplashScreenProps {
  onEnter: () => void;
}

export const SplashScreen: React.FC<SplashScreenProps> = ({ onEnter }) => {
  const [fading, setFading] = useState(false);

  const handleEnter = () => {
    setFading(true);
    setTimeout(onEnter, 500);
  };

  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 9999,
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        boxSizing: 'border-box',
        padding: '24px 16px 16px',
        backgroundColor: '#0d1117',
        transition: 'opacity 0.5s',
        opacity: fading ? 0 : 1,
        pointerEvents: fading ? 'none' : 'all',
      }}
    >
      <div
        style={{
          display: 'flex',
          flex: '1 1 auto',
          width: '100%',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          gap: 28,
        }}
      >
        <img
          src={logo}
          alt="VoxShop"
          style={{ width: 'min(80vw, 720px)', height: 'auto', maxHeight: '30vh', objectFit: 'contain' }}
        />

        <button
          onClick={handleEnter}
          style={{
            marginTop: 0,
            padding: '18px clamp(24px, 8vw, 72px)',
            background: '#2563eb',
            color: '#fff',
            border: 'none',
            borderRadius: 14,
            fontSize: 15,
            fontWeight: 900,
            letterSpacing: '0.3em',
            textTransform: 'uppercase',
            cursor: 'pointer',
          }}
        >
          Enter VoxShop
        </button>
      </div>

      <div
        style={{
          boxSizing: 'border-box',
          width: '100%',
          borderTop: '1px solid rgba(255,255,255,0.05)',
          padding: '16px 16px 0',
          display: 'flex',
          flexWrap: 'wrap',
          alignItems: 'center',
          justifyContent: 'center',
          gap: 12,
        }}
      >
        <a
          href="https://www.paypal.com/ncp/payment/MNF5JL9WPEJ92"
          target="_blank"
          rel="noopener noreferrer"
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            padding: '10px 20px',
            background: 'rgba(0,48,135,0.2)',
            border: '1px solid rgba(0,48,135,0.3)',
            borderRadius: 10,
            color: '#60a5fa',
            fontSize: 11,
            fontWeight: 700,
            letterSpacing: '0.15em',
            textTransform: 'uppercase',
            textDecoration: 'none',
            cursor: 'pointer',
          }}
        >
          <Heart size={13} strokeWidth={3} />
          Support VoxShop
        </a>

        <a
          href="https://github.com/Hexxis-Studios/voxshop"
          target="_blank"
          rel="noopener noreferrer"
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            padding: '10px 20px',
            background: 'rgba(255,255,255,0.05)',
            border: '1px solid rgba(255,255,255,0.08)',
            borderRadius: 10,
            color: '#94a3b8',
            fontSize: 11,
            fontWeight: 700,
            letterSpacing: '0.15em',
            textTransform: 'uppercase',
            textDecoration: 'none',
            cursor: 'pointer',
          }}
        >
          <Github size={13} strokeWidth={2} />
          Hexxis Studios
        </a>
      </div>
    </div>
  );
};
