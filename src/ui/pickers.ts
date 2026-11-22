import { addFileList, openFolder } from '../store/controller';

const ACCEPT = 'audio/*,.flac,.wav,.aif,.aiff,.aifc,.m4a,.opus,.ogg,.ape,.wv,.dsf,.dff';

/** Opens the native file dialog; with `directory` it picks a whole folder. */
export function pickFiles(directory = false) {
  const input = document.createElement('input');
  input.type = 'file';
  input.multiple = true;
  input.accept = ACCEPT;
  if (directory) input.webkitdirectory = true;
  input.onchange = () => addFileList(input.files);
  input.click();
}

export function pickFolder() {
  const fallback = document.createElement('input');
  fallback.type = 'file';
  fallback.webkitdirectory = true;
  fallback.onchange = () => addFileList(fallback.files);
  void openFolder(fallback);
}
