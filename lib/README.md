# Required: CSInterface.js

The panel loads **CSInterface.js** from this folder. Without it you get:

`Failed to load resource: net::ERR_FILE_NOT_FOUND` for `CSInterface.js`

and the extension cannot talk to After Effects.

## What to do

1. **Download CSInterface.js** from Adobe's CEP-Resources:
   - Open: **https://github.com/Adobe-CEP/CEP-Resources**
   - Open the **CEP_11.x** folder (or **CEP_9.x** / **CEP_8.x** if 11 is not there).
   - Click **CSInterface.js**, then click **Raw** (or "Download").
   - Save the file as **CSInterface.js** into this folder:
     `Cloud.ru Motion Export/lib/`
   - You should end up with: `Cloud.ru Motion Export/lib/CSInterface.js`

2. **Reload the extension**: close the panel in After Effects and open it again (or restart AE).

After that, the Console error for CSInterface.js should go away and the panel can call `evalScript` to extract the active composition and open the folder picker.
