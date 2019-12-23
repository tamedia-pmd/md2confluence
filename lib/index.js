const rp = require('request-promise');
const inquirer = require('inquirer');
const markdown2confluence = require('markdown2confluence');
const fsp = require('fs-promise');
const fs = require('fs');
const path = require('path');
const { createLogger, format, transports } = require('winston');

// A preffer to use this instead console.log
const logger = createLogger({
  transports: [new transports.Console()],
  exitOnError: true,
  format: format.cli(),
});
const prompts = [];
const user = process.env.MD2CUSER;
const pass = process.env.MD2CPASS;
const apiKey = process.env.CONFLUENCE_API_GATEWAY_KEY;
let config;

/*
 * Let's read the config file
 */
try {
  config = JSON.parse(fs.readFileSync(path.join('.md2confluence-rc'), 'utf8'));
} catch (err) {
  if (err.code === 'ENOENT') {
    logger.error('File .md2confluence-rc not found!');
    process.exit(1);
  } else {
    throw err;
  }
}

if (user) {
  config.user = user;
}

if (pass) {
  config.pass = pass;
}


inquirer.prompt(prompts).then((_answers) => {
  const answers = _answers;
  answers.apiKey = apiKey;

  // For any file in the .md2confluence-rc file...
  for (let i = 0; i < config.pages.length; i += 1) {
    const pageData = config.pages[i];

    logger.debug(`Starting to render "${pageData.mdfile}"`);

    // 1. Get the markdown file content
    fsp
      .readFile(pageData.mdfile, { encoding: 'utf8' })
      .then((fileData) => {
        // 2. Transform the content to Markdown Wiki
        let mdWikiData = markdown2confluence(fileData);
        let currentPage;
        let newContent;

        const prefix = config.prefix || '';

        // Add the prefix (if defined) to the beginning of the wiki data
        if (prefix) {
          mdWikiData = `{info}${prefix}{info}\n\n${mdWikiData}`;
        }

        const dir = './tmp';

        if (!fs.existsSync(dir)) {
          fs.mkdirSync(dir);
        }

        const tempFile = `${dir}/${pageData.pageid}`;

        let needsContentUpdate = true;
        if (fs.existsSync(tempFile)) {
          const fileContent = fs.readFileSync(tempFile, 'utf-8');

          if (fileContent === mdWikiData) {
            needsContentUpdate = false;
          }
        }

        fs.writeFileSync(tempFile, mdWikiData, 'utf-8');

        let promise;
        needsContentUpdate = true;

        if (needsContentUpdate) {
          // 3. Transform the Markdown Wiki to Storage (confluence scripting)
          promise = (
            rp({
              method: 'POST',
              uri: `${config.baseUrl}/contentbody/convert/storage`,
              headers: {
                'Content-Type': 'application/json',
                'api-key': answers.apiKey,
              },
              body: {
                value: mdWikiData,
                representation: 'wiki',
              },
              json: true, // Automatically stringifies the body to JSON
            })
              // 4. Get current data of the confluence page
              .then((data) => {
                newContent = data;

                return rp({
                  method: 'GET',
                  uri: `${config.baseUrl}/content/${pageData.pageid}`,
                  headers: {
                    'api-key': answers.apiKey,
                  },
                  body: {
                    some: 'payload',
                  },
                  json: true, // Automatically stringifies the body to JSON
                });
              })

              // 5. Update the page in confluence
              .then((data) => {
                currentPage = data;
                currentPage.title = pageData.title;
                currentPage.body = {
                  storage: {
                    value: newContent.value,
                    representation: 'storage',
                  },
                };
                currentPage.version.number = parseInt(currentPage.version.number, 10) + 1;

                return rp({
                  method: 'PUT',
                  uri: `${config.baseUrl}/content/${pageData.pageid}`,
                  headers: {
                    'Content-Type': 'application/json',
                    'api-key': answers.apiKey,
                  },
                  body: currentPage,
                  json: true, // Automatically stringifies the body to JSON
                });
              })

              // everything is saved
              .then(() => {
                logger.info(`"${currentPage.title}" saved in confluence.`);
              })
          );
        } else {
          logger.info(`No content update necessary for "${pageData.mdfile}"`);
        }

        return promise;
      })
      .catch((err) => {
        logger.error(err);
      });
  }
});
