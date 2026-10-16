import { Menu, X } from 'lucide-react';
import { useEffect, useState } from 'react';
import { NavLink, Route, Routes, useLocation } from 'react-router-dom';
import { Container, cn } from './components/ui/index.js';
import Home from './pages/Home.jsx';

const NAV = [{ to: '/', label: 'Home' }];
const BRAND = 'App';

function NavBar() {
  const [open, setOpen] = useState(false);
  const [scrolled, setScrolled] = useState(false);
  const { pathname } = useLocation();
  useEffect(() => setOpen(false), [pathname]);
  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 8);
    onScroll();
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => window.removeEventListener('scroll', onScroll);
  }, []);

  const link = ({ isActive }) =>
    cn('rounded-full px-3.5 py-2 text-sm font-medium transition', isActive ? 'bg-primary-50 text-primary-700' : 'text-muted hover:text-fg');

  return (
    <header className={cn('sticky top-0 z-40 transition-all', scrolled ? 'border-b border-line bg-surface/80 backdrop-blur-xl' : 'bg-transparent')}>
      <Container className="flex h-16 items-center justify-between">
        <NavLink to="/" className="font-display text-lg font-bold tracking-tight text-fg">{BRAND}</NavLink>
        <nav className="hidden items-center gap-1 md:flex">
          {NAV.map((n) => <NavLink key={n.to} to={n.to} end className={link}>{n.label}</NavLink>)}
        </nav>
        <button className="rounded-full p-2 text-fg md:hidden" onClick={() => setOpen(!open)} aria-label="Menu">
          {open ? <X className="h-6 w-6" /> : <Menu className="h-6 w-6" />}
        </button>
      </Container>
      {open && (
        <nav className="border-t border-line bg-surface px-5 py-3 md:hidden">
          {NAV.map((n) => <NavLink key={n.to} to={n.to} end className={({ isActive }) => cn('block rounded-brand px-3 py-2.5 text-sm font-medium', isActive ? 'bg-primary-50 text-primary-700' : 'text-fg')}>{n.label}</NavLink>)}
        </nav>
      )}
    </header>
  );
}

function Footer() {
  return (
    <footer className="mt-24 border-t border-line">
      <Container className="flex flex-wrap items-center justify-between gap-4 py-10 text-sm text-muted">
        <span className="font-display font-semibold text-fg">{BRAND}</span>
        <span>© {new Date().getFullYear()} {BRAND}. All rights reserved.</span>
      </Container>
    </footer>
  );
}

export default function App() {
  return (
    <div className="flex min-h-screen flex-col">
      <NavBar />
      <main className="flex-1">
        <Routes>
          <Route path="/" element={<Home />} />
          <Route path="*" element={<Container className="py-24 text-center"><h1 className="text-4xl font-bold">Page not found</h1></Container>} />
        </Routes>
      </main>
      <Footer />
    </div>
  );
}
