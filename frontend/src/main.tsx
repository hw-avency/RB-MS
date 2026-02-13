import React from 'react';
import ReactDOM from 'react-dom/client';
import { ChakraProvider, ColorModeScript } from '@chakra-ui/react';
import { SaasProvider } from '@saas-ui/react';
import { theme as saasTheme } from '@saas-ui/theme';
import { App } from './App';
import './styles.css';

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <ColorModeScript initialColorMode={saasTheme.config.initialColorMode} />
    <ChakraProvider theme={saasTheme}>
      <SaasProvider>
        <App />
      </SaasProvider>
    </ChakraProvider>
  </React.StrictMode>
);
