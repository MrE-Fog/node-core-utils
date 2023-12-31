import auth from '../../lib/auth.js';
import { parsePRFromURL } from '../../lib/links.js';
import { getMetadata } from '../metadata.js';
import CLI from '../../lib/cli.js';
import Request from '../../lib/request.js';
import { runPromise } from '../../lib/run.js';
import LandingSession from '../../lib/landing_session.js';
import epilogue from './epilogue.js';

export const command = 'land [prid|options]';
export const describe =
  'Manage the current landing session or start a new one for a pull request';

const landActions = {
  apply: {
    describe: 'Apply a patch with the given PR id',
    type: 'number'
  },
  amend: {
    describe: 'Amend the current commit',
    type: 'boolean'
  },
  continue: {
    alias: 'c',
    describe: 'Continue the landing session',
    type: 'boolean'
  },
  final: {
    describe: 'Verify the landed PR and clean up',
    type: 'boolean'
  },
  abort: {
    describe: 'Abort the current landing session',
    type: 'boolean'
  },
  backport: {
    describe: 'Land a backport PR onto a staging branch',
    default: false,
    type: 'boolean'
  },
  'gpg-sign': {
    describe: 'GPG-sign commits, will be passed to the git process',
    alias: 'S'
  },
  autorebase: {
    describe: 'Automatically rebase branches with multiple commits',
    default: false,
    type: 'boolean'
  },
  fixupAll: {
    describe: 'Automatically fixup all commits to the first one dismissing ' +
      'other commit messages',
    default: false,
    type: 'boolean'
  },
  oneCommitMax: {
    describe: 'When run in conjunction with the --yes and --autorebase ' +
      'options, will abort the session if trying to land more than one commit',
    default: false,
    type: 'boolean'
  }
};

const landOptions = {
  yes: {
    type: 'boolean',
    default: false,
    describe: 'Assume "yes" as answer to all prompts and run ' +
    'non-interactively. If an undesirable situation occurs, such as a pull ' +
    'request or commit check fails, then git node land will abort.'
  },
  skipRefs: {
    describe: 'Prevent adding Fixes and Refs information to commit metadata',
    default: false,
    type: 'boolean'
  },
  lint: {
    describe: 'Run linter while landing commits',
    default: false,
    type: 'boolean'
  },
  checkCI: {
    describe: 'Query Jenkins CI results when checking the PR',
    default: true,
    type: 'boolean'
  }
};

let yargsInstance;

export function builder(yargs) {
  yargsInstance = yargs;
  return yargs
    .options(Object.assign({}, landOptions, landActions))
    .positional('prid', {
      describe: 'ID or URL of the Pull Request'
    })
    .epilogue(epilogue)
    .example('git node land https://github.com/nodejs/node/pull/12344',
      'Land https://github.com/nodejs/node/pull/12344 in the current directory')
    .example('git node land 12344',
      'Land https://github.com/nodejs/node/pull/12344 in the current directory')
    .example('git node land --abort',
      'Abort the current session')
    .example('git node land --amend',
      'Append metadata to the current commit message')
    .example('git node land --final',
      'Verify the landed PR and clean up')
    .example('git node land --continue',
      'Continue the current landing session');
}

const START = 'start';
const APPLY = 'apply';
const AMEND = 'amend';
const FINAL = 'final';
const CONTINUE = 'continue';
const ABORT = 'abort';

export function handler(argv) {
  if (argv.prid) {
    if (Number.isInteger(argv.prid)) {
      return land(START, argv);
    } else {
      const parsed = parsePRFromURL(argv.prid);
      if (parsed) {
        Object.assign(argv, parsed);
        return land(START, argv);
      }
    }
    yargsInstance.showHelp();
    return;
  }

  const provided = [];
  for (const type of Object.keys(landActions)) {
    if (argv[type]) {
      provided.push(type);
    }
  }

  if (provided.length === 1) {
    return land(provided[0], argv);
  }

  // If the more than one action is provided or no valid action
  // is provided, show help.
  yargsInstance.showHelp();
}

function land(state, argv) {
  const cli = new CLI(process.stderr);
  if (argv.yes) {
    cli.setAssumeYes();
  }
  const dir = process.cwd();

  return runPromise(main(state, argv, cli, dir)).catch((err) => {
    if (cli.spinner.enabled) {
      cli.spinner.fail();
    }
    throw err;
  });
}

async function main(state, argv, cli, dir) {
  const credentials = await auth({
    github: true
  });
  const req = new Request(credentials);
  let session = new LandingSession(cli, req, dir);

  if (state !== AMEND &&
      state !== CONTINUE &&
      await session.warnForWrongBranch()) {
    return;
  }

  if (argv.yes) {
    cli.setAssumeYes();
  }
  try {
    session.restore();
  } catch (err) { // JSON error?
    if (state === ABORT) {
      await session.abort();
      return;
    }
    cli.warn(
      'Failed to detect previous session. ' +
      'please run `git node land --abort`');
    return;
  }

  if (state === START) {
    if (session.hasStarted()) {
      cli.warn(
        'Previous `git node land` session for ' +
        `${session.pullName} in progress.`);
      cli.log('run `git node land --abort` before starting a new session');
      return;
    }
    session = new LandingSession(cli, req, dir, argv);
    const metadata = await getMetadata(session.argv, argv.skipRefs, cli);
    if (argv.backport) {
      const split = metadata.metadata.split('\n')[0];
      if (split === 'PR-URL: ') {
        cli.error('Commit message is missing PR-URL');
      }
    }
    return session.start(metadata);
  } else if (state === APPLY) {
    return session.apply();
  } else if (state === AMEND) {
    return session.amend();
  } else if (state === FINAL) {
    return session.final();
  } else if (state === ABORT) {
    return session.abort();
  } else if (state === CONTINUE) {
    return session.continue();
  }
}
