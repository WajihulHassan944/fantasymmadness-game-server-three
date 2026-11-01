// Mounts the website's admin GrowthEngineBridge component on its own page for testing.
import React from 'react';
import { createRoot } from 'react-dom/client';
import GrowthEngineBridge from '@/Components/Admin/GrowthEngineBridge';
createRoot(document.getElementById('root')).render(<GrowthEngineBridge />);
