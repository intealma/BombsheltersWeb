import { render } from 'preact';
import '@fontsource/nunito-sans/400.css';
import '@fontsource/nunito-sans/600.css';
import '@fontsource/nunito-sans/700.css';
import './styles.css';
import { App } from './app';

render(<App />, document.getElementById('app')!);
