import {pathToFileURL} from 'node:url';

/** Use a project-local Playwright installation unless an exact module path is supplied. */
export async function loadPlaywright() {
  const modulePath=process.env.PLAYWRIGHT_MODULE;
  try {
    return modulePath ? await import(pathToFileURL(modulePath).href) : await import('playwright');
  } catch (cause) {
    const detail=modulePath ? `Cannot load PLAYWRIGHT_MODULE=${modulePath}. Check that it points to the Playwright module file.` : 'Playwright is not available in this project.';
    throw new Error(`${detail}\nInstall browser test dependencies with:\n  npm install --no-save --package-lock=false playwright\n  npx playwright install chromium\nAlternatively, set PLAYWRIGHT_MODULE to an existing Playwright module file.`,{cause});
  }
}

/** SwiftShader keeps smoke checks reproducible without a native GPU. */
export function browserLaunchOptions() {
  const options={headless:true,args:['--use-angle=swiftshader','--enable-unsafe-swiftshader']};
  if(process.env.CHROME_PATH)options.executablePath=process.env.CHROME_PATH;
  return options;
}
