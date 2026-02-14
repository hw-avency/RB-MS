import { FormEvent, ReactNode, useEffect, useMemo, useState } from 'react';
import { ApiError, del, get, patch, post } from '../api';

type Floorplan = { id: string; name: string; imageUrl: string; createdAt?: string; updatedAt?: string };
type Desk = { id: string; floorplanId: string; name: string; x: number; y: number };
type Employee = { id: string; email: string; displayName: string; isActive: boolean };
type Booking = { id: string; deskId: string; userEmail: string; userDisplayName?: string; date: string; createdAt?: string };

const adminNav = [
  { to: '/admin', label: 'Dashboard' },
  { to: '/admin/floorplans', label: 'Floorpläne' },
  { to: '/admin/desks', label: 'Desks' },
  { to: '/admin/bookings', label: 'Buchungen' },
  { to: '/admin/employees', label: 'Mitarbeiter' }
];

const authHeaders = () => ({ Authorization: `Bearer ${localStorage.getItem('rbms-admin-token') ?? ''}` });
const formatDate = (value?: string) => (value ? new Date(value).toLocaleString('de-DE') : '—');
const today = new Date().toISOString().slice(0, 10);
const plus14 = new Date(Date.now() + 14 * 86400000).toISOString().slice(0, 10);

function useToast() { const [msg, setMsg] = useState(''); useEffect(()=>{if(!msg)return;const t=setTimeout(()=>setMsg(''),3000);return()=>clearTimeout(t);},[msg]); return {msg,setMsg}; }

function AdminLayout({ path, navigate, children, search, onSearch }: { path: string; navigate: (to: string) => void; children: ReactNode; search?: string; onSearch?: (v: string)=>void }) {
  const breadcrumb = path.replace('/admin', '').split('/').filter(Boolean).join(' / ') || 'Dashboard';
  return <div className="admin-shell"><aside className="admin-sidebar card stack-sm"><h3>Admin</h3>{adminNav.map((item)=><button key={item.to} className={`btn btn-ghost admin-nav-link ${path === item.to ? 'active' : ''}`} onClick={()=>navigate(item.to)}>{item.label}</button>)}<button className="btn btn-outline" onClick={()=>{localStorage.removeItem('rbms-admin-token');navigate('/admin/login');}}>Logout</button></aside><section className="admin-content"><header className="card admin-topbar"><strong>Admin / {breadcrumb}</strong><input placeholder="Suchen…" value={search ?? ''} onChange={(e)=>onSearch?.(e.target.value)} /></header>{children}</section></div>;
}

function AdminLogin({ navigate }: { navigate: (to: string) => void }) {
  const [email, setEmail] = useState('admin@example.com'); const [password, setPassword] = useState(''); const [error, setError] = useState('');
  const submit = async (e: FormEvent) => {e.preventDefault(); try { const res = await post<{ token: string }>('/admin/login', { email, password }); localStorage.setItem('rbms-admin-token', res.token); navigate('/admin'); } catch (err) { setError(err instanceof Error ? err.message : 'Login fehlgeschlagen'); } };
  return <main className="app-shell"><section className="card stack-sm down-card"><h2>Admin Login</h2><form onSubmit={submit} className="stack-sm"><input value={email} onChange={(e)=>setEmail(e.target.value)} /><input type="password" value={password} onChange={(e)=>setPassword(e.target.value)} placeholder="Passwort" />{error && <p className="error-banner">{error}</p>}<button className="btn">Einloggen</button></form></section></main>;
}

function Dashboard({ path, navigate }: { path: string; navigate: (to: string)=>void }) { return <AdminLayout path={path} navigate={navigate}><section className="card"><h2>Admin Dashboard</h2></section></AdminLayout>; }

function FloorplansPage({ path, navigate }: { path: string; navigate: (to: string)=>void }) { const [rows,setRows]=useState<Floorplan[]>([]); const [loading,setLoading]=useState(false); const [search,setSearch]=useState(''); const [name,setName]=useState(''); const [imageUrl,setImageUrl]=useState(''); const [editId,setEditId]=useState(''); const [error,setError]=useState(''); const {msg,setMsg}=useToast();
  const load=async()=>{setLoading(true);setError('');try{setRows(await get<Floorplan[]>('/floorplans'));}catch(e){setError(e instanceof Error?e.message:'Fehler');}finally{setLoading(false);}}; useEffect(()=>{load();},[]);
  const filtered=useMemo(()=>rows.filter((r)=>r.name.toLowerCase().includes(search.toLowerCase())),[rows,search]);
  const save=async(e:FormEvent)=>{e.preventDefault(); try{if(editId){await patch(`/admin/floorplans/${editId}`,{name,imageUrl},authHeaders());}else{await post('/admin/floorplans',{name,imageUrl},authHeaders());} setMsg('Gespeichert'); setName(''); setImageUrl(''); setEditId(''); load();}catch(err){setError(err instanceof Error?err.message:'Fehler');}};
  return <AdminLayout path={path} navigate={navigate} search={search} onSearch={setSearch}><section className="card stack-sm"><h2>Floorpläne</h2><form className="inline-grid-two" onSubmit={save}><input required placeholder="Name" value={name} onChange={(e)=>setName(e.target.value)} /><input required placeholder="Image URL" value={imageUrl} onChange={(e)=>setImageUrl(e.target.value)} /><button className="btn">Speichern</button></form>{error&&<p className="error-banner">{error}</p>}<table><thead><tr><th>Name</th><th>Zuletzt geändert</th><th>Status</th><th/></tr></thead><tbody>{loading ? <tr><td colSpan={4}><div className="skeleton h-64"/></td></tr> : filtered.length===0 ? <tr><td colSpan={4}>Keine Floorpläne. Neu anlegen.</td></tr> : filtered.map((r)=><tr key={r.id}><td>{r.name}</td><td>{formatDate(r.updatedAt || r.createdAt)}</td><td><span className="badge">aktiv</span></td><td><button className="btn btn-ghost" onClick={()=>{setEditId(r.id);setName(r.name);setImageUrl(r.imageUrl);}}>Bearbeiten</button><button className="btn btn-outline" onClick={async()=>{if(confirm(`Löschen ${r.name}?`)){await del(`/admin/floorplans/${r.id}`,authHeaders());load();}}}>Löschen</button></td></tr>)}</tbody></table>{msg&&<p className="success-banner">{msg}</p>}</section></AdminLayout>; }

function DesksPage({ path, navigate }: { path: string; navigate: (to: string)=>void }) { const [fps,setFps]=useState<Floorplan[]>([]);const [floorplanId,setFloorplanId]=useState('');const [rows,setRows]=useState<Desk[]>([]);const [search,setSearch]=useState('');const [name,setName]=useState('');const [x,setX]=useState(50);const [y,setY]=useState(50); const [error,setError]=useState('');
  useEffect(()=>{(async()=>{const f=await get<Floorplan[]>('/floorplans');setFps(f);setFloorplanId(f[0]?.id ?? '');})();},[]);
  const load=async(id:string)=>{if(!id)return;setRows(await get<Desk[]>(`/floorplans/${id}/desks`));}; useEffect(()=>{load(floorplanId);},[floorplanId]);
  return <AdminLayout path={path} navigate={navigate} search={search} onSearch={setSearch}><section className="card stack-sm"><h2>Desks</h2><select value={floorplanId} onChange={(e)=>setFloorplanId(e.target.value)}>{fps.map((f)=><option key={f.id} value={f.id}>{f.name}</option>)}</select><form className="inline-grid-two" onSubmit={async(e)=>{e.preventDefault();try{await post(`/admin/floorplans/${floorplanId}/desks`,{name,x,y},authHeaders());setName('');load(floorplanId);}catch(err){setError(err instanceof Error?err.message:'Fehler');}}}><input required placeholder="Desk-Label" value={name} onChange={(e)=>setName(e.target.value)}/><button className="btn btn-outline" type="button" onClick={()=>{setX(Math.floor(Math.random()*100));setY(Math.floor(Math.random()*100));}}>Position setzen</button><small>Position gesetzt: {x}/{y}</small><button className="btn">Speichern</button></form>{error&&<p className="error-banner">{error}</p>}<table><thead><tr><th>Desk</th><th>Position</th><th/></tr></thead><tbody>{rows.filter((r)=>r.name.toLowerCase().includes(search.toLowerCase())).map((d)=><tr key={d.id}><td>{d.name}</td><td>{d.x},{d.y}</td><td><button className="btn btn-outline" onClick={async()=>{if(confirm('Desk löschen?')){await del(`/admin/desks/${d.id}`,authHeaders());load(floorplanId);}}}>Löschen</button></td></tr>)}</tbody></table></section></AdminLayout>; }

function BookingsPage({ path, navigate }: { path: string; navigate: (to: string)=>void }) { const [rows,setRows]=useState<Booking[]>([]); const [search,setSearch]=useState(''); const [from,setFrom]=useState(today); const [to,setTo]=useState(plus14); const [floorplans,setFloorplans]=useState<Floorplan[]>([]); const [floorplanId,setFloorplanId]=useState(''); const [error,setError]=useState('');
useEffect(()=>{(async()=>{const f=await get<Floorplan[]>('/floorplans');setFloorplans(f);setFloorplanId(f[0]?.id ?? '');})();},[]);
const load=async()=>{try{setRows(await get<Booking[]>(`/bookings?from=${from}&to=${to}${floorplanId ? `&floorplanId=${floorplanId}`:''}`));}catch(e){setError(e instanceof Error?e.message:'Fehler');}};useEffect(()=>{load();},[from,to,floorplanId]);
return <AdminLayout path={path} navigate={navigate} search={search} onSearch={setSearch}><section className="card stack-sm"><h2>Buchungen</h2><div className="inline-grid-two"><input type="date" value={from} onChange={(e)=>setFrom(e.target.value)}/><input type="date" value={to} onChange={(e)=>setTo(e.target.value)}/><select value={floorplanId} onChange={(e)=>setFloorplanId(e.target.value)}><option value="">Alle</option>{floorplans.map((f)=><option key={f.id} value={f.id}>{f.name}</option>)}</select><button className="btn" onClick={load}>Retry</button></div>{error&&<p className="error-banner">{error}</p>}<table><thead><tr><th>Datum</th><th>Person</th><th>Desk</th><th>Typ</th><th/></tr></thead><tbody>{rows.filter((r)=>`${r.userDisplayName ?? ''}${r.userEmail}`.toLowerCase().includes(search.toLowerCase())).map((b)=><tr key={b.id}><td>{formatDate(b.date)}</td><td>{b.userDisplayName || b.userEmail}</td><td>{b.deskId}</td><td>Einzeln</td><td><button className="btn btn-outline" onClick={async()=>{await del(`/admin/bookings/${b.id}`,authHeaders());load();}}>Löschen</button></td></tr>)}</tbody></table></section></AdminLayout>; }

function EmployeesPage({ path, navigate }: { path: string; navigate: (to: string)=>void }) { const [rows,setRows]=useState<Employee[]>([]);const [search,setSearch]=useState('');const [name,setName]=useState('');const [email,setEmail]=useState('');const [error,setError]=useState('');
const load=async()=>{try{setRows(await get<Employee[]>('/admin/employees',authHeaders()));}catch(e){setError(e instanceof Error?e.message:'Fehler');}};useEffect(()=>{load();},[]);
return <AdminLayout path={path} navigate={navigate} search={search} onSearch={setSearch}><section className="card stack-sm"><h2>Mitarbeiter</h2><form className="inline-grid-two" onSubmit={async(e)=>{e.preventDefault();try{await post('/admin/employees',{displayName:name,email},authHeaders());setName('');setEmail('');load();}catch(err){setError(err instanceof ApiError?err.message:'Fehler');}}}><input required placeholder="Name" value={name} onChange={(e)=>setName(e.target.value)}/><input required type="email" placeholder="E-Mail" value={email} onChange={(e)=>setEmail(e.target.value)}/><button className="btn">Neu</button></form>{error&&<p className="error-banner">{error}</p>}<table><thead><tr><th>Name</th><th>E-Mail</th><th>Rolle</th><th>Status</th><th/></tr></thead><tbody>{rows.filter((r)=>`${r.displayName}${r.email}`.toLowerCase().includes(search.toLowerCase())).map((e)=><tr key={e.id}><td>{e.displayName}</td><td>{e.email}</td><td>User</td><td>{e.isActive?'aktiv':'deaktiviert'}</td><td><button className="btn btn-ghost" onClick={async()=>{await patch(`/admin/employees/${e.id}`,{isActive:!e.isActive},authHeaders());load();}}>{e.isActive?'Deaktivieren':'Aktivieren'}</button></td></tr>)}</tbody></table></section></AdminLayout>; }

export function AdminRouter({ path, navigate }: { path: string; navigate: (to: string) => void }) {
  const [allowed, setAllowed] = useState<boolean | null>(null);

  useEffect(() => {
    (async () => {
      if (path === '/admin/login') return setAllowed(false);
      const token = localStorage.getItem('rbms-admin-token');
      if (!token) return setAllowed(false);
      try { await get('/admin/employees', authHeaders()); setAllowed(true); } catch { setAllowed(false); }
    })();
  }, [path]);

  if (path === '/admin/login') return <AdminLogin navigate={navigate} />;
  if (allowed === null) return <main className="app-shell"><section className="card">Prüfe Berechtigung…</section></main>;
  if (!allowed) return <main className="app-shell"><section className="card stack-sm down-card"><h2>Keine Berechtigung</h2><button className="btn" onClick={() => navigate('/admin/login')}>Zum Login</button></section></main>;

  if (path === '/admin') return <Dashboard path={path} navigate={navigate} />;
  if (path === '/admin/floorplans') return <FloorplansPage path={path} navigate={navigate} />;
  if (path === '/admin/desks') return <DesksPage path={path} navigate={navigate} />;
  if (path === '/admin/bookings') return <BookingsPage path={path} navigate={navigate} />;
  if (path === '/admin/employees') return <EmployeesPage path={path} navigate={navigate} />;
  return <main className="app-shell"><section className="card stack-sm down-card"><h2>Admin-Seite nicht gefunden</h2><button className="btn" onClick={() => navigate('/admin')}>Dashboard</button></section></main>;
}
