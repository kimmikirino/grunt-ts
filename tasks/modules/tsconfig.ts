'use strict';

import {Promise} from 'es6-promise';
import * as fs from 'fs';
import * as path from 'path';
import * as stripBom from 'strip-bom';
import * as _ from 'lodash';
import * as utils from './utils';

let templateProcessor: (templateString: string, options: any) => string = null;
let globExpander: (globs: string[]) => string[] = null;
let gruntfileGlobs : string[] = null;
let absolutePathToTSConfig: string;

export function resolveAsync(applyTo: IGruntTSOptions,
  taskOptions: ITargetOptions,
  targetOptions: ITargetOptions,
  theTemplateProcessor: (templateString: string, options: any) => string,
  theGlobExpander: (globs: string[]) => string[] = null) {

  templateProcessor = theTemplateProcessor;
  globExpander = theGlobExpander;
  gruntfileGlobs = getGlobs(taskOptions, targetOptions);

  return new Promise<IGruntTSOptions>((resolve, reject) => {

    try {
      const taskTSConfig = getTSConfigSettings(taskOptions);
      const targetTSConfig = getTSConfigSettings(targetOptions);

      let tsconfig: ITSConfigSupport = null;

      if (taskTSConfig) {
        tsconfig = taskTSConfig;
      }
      if (targetTSConfig) {
        if (!tsconfig) {
          tsconfig = targetTSConfig;
        }

        if ('tsconfig' in targetTSConfig) {
          tsconfig.tsconfig = templateProcessor(targetTSConfig.tsconfig, {});
        }
        if ('ignoreSettings' in targetTSConfig) {
          tsconfig.ignoreSettings = targetTSConfig.ignoreSettings;
        }
        if ('overwriteFilesGlob' in targetTSConfig) {
          tsconfig.overwriteFilesGlob = targetTSConfig.overwriteFilesGlob;
        }
        if ('updateFiles' in targetTSConfig) {
          tsconfig.updateFiles = targetTSConfig.updateFiles;
        }
        if ('passThrough' in targetTSConfig) {
          tsconfig.passThrough = targetTSConfig.passThrough;
        }
      }

      applyTo.tsconfig = tsconfig;

    } catch (ex) {
      return reject(ex);
    }

    if (!applyTo.tsconfig) {
      return resolve(applyTo);
    }

    if ((<ITSConfigSupport>applyTo.tsconfig).passThrough) {
      if (applyTo.CompilationTasks.length === 0) {
        applyTo.CompilationTasks.push({src: []});
      }
      if (!(<ITSConfigSupport>applyTo.tsconfig).tsconfig) {
        (<ITSConfigSupport>applyTo.tsconfig).tsconfig = '.';
      }
    } else {
      let projectFile = (<ITSConfigSupport>applyTo.tsconfig).tsconfig;
      try {
        var projectFileTextContent = fs.readFileSync(projectFile, 'utf8');
      } catch (ex) {
        if (ex && ex.code === 'ENOENT') {
            return reject('Could not find file "' + projectFile + '".');
        } else if (ex && ex.errno) {
            return reject('Error ' + ex.errno + ' reading "' + projectFile + '".');
        } else {
            return reject('Error reading "' + projectFile + '": ' + JSON.stringify(ex));
        }
      }

      try {
        var projectSpec: ITSConfigFile;
        const content = stripBom(projectFileTextContent);
        if (content.trim() === '') {
          projectSpec = {};
        } else {
          projectSpec = JSON.parse(content);
        }
      } catch (ex) {
        return reject('Error parsing "' + projectFile + '".  It may not be valid JSON in UTF-8.');
      }

      applyTo = handleBadConfiguration(applyTo, projectSpec);
      applyTo = applyCompilerOptions(applyTo, projectSpec);
      applyTo = resolve_output_locations(applyTo, projectSpec);
    }

    resolve(applyTo);
  });
}


function handleBadConfiguration(options: IGruntTSOptions, projectSpec: ITSConfigFile) {
  if (projectSpec.compilerOptions) {
    if (projectSpec.compilerOptions.out && projectSpec.compilerOptions.outFile) {
      options.warnings.push('Warning: `out` and `outFile` should not be used together in tsconfig.json.');
    }
    if (projectSpec.compilerOptions.out) {
      options.warnings.push('Warning: Using `out` in tsconfig.json can be unreliable because it will output relative' +
        ' to the tsc working directory.  It is better to use `outFile` which is always relative to tsconfig.json, ' +
        ' but this requires TypeScript 1.6 or higher.');
    }
  }

  const tsconfigSetting = options.tsconfig as ITSConfigSupport;
  if (projectSpec.include && tsconfigSetting.overwriteFilesGlob) {
    options.errors.push('Error: grunt-ts does not support using the `overwriteFilesGlob` feature with a tsconfig.json' +
      ' file that has an `include` array.  If your version of TypeScript supports `include`, you should just use that.');
  }
  if (projectSpec.include && tsconfigSetting.updateFiles) {
    options.errors.push('Error: grunt-ts does not support using the `updateFiles` feature with a tsconfig.json' +
      ' file that has an `include` array.  If your version of TypeScript supports `include`, you should just use that.');
  }

  return options;
}


function getGlobs(taskOptions: ITargetOptions, targetOptions: ITargetOptions) {
  let globs = null;

  if (taskOptions && isStringOrArray((<any>taskOptions).src)) {
    globs = _.map(getFlatCloneOf([(<any>taskOptions).src]), item => templateProcessor(item, {}));
  }
  if (targetOptions && isStringOrArray((<any>targetOptions).src)) {
    globs = _.map(getFlatCloneOf([(<any>targetOptions).src]), item => templateProcessor(item, {}));
  }

  return globs;

  function isStringOrArray(thing: any) {
    return (_.isArray(thing) || _.isString(thing));
  }

  function getFlatCloneOf(array: Array<any>) {
    return [...(<any>_.flattenDeep(array))];
  }
}

function resolve_output_locations(options: IGruntTSOptions, projectSpec: ITSConfigFile) {
  if (options.CompilationTasks
      && options.CompilationTasks.length > 0
      && projectSpec
      && projectSpec.compilerOptions) {
    options.CompilationTasks.forEach((compilationTask) => {
        if (projectSpec.compilerOptions.out) {
          compilationTask.out = path.normalize(
            projectSpec.compilerOptions.out
          ).replace(/\\/g, '/');
        }
        if (projectSpec.compilerOptions.outFile) {
          compilationTask.out = path.normalize(path.join(
            relativePathFromGruntfileToTSConfig(),
            projectSpec.compilerOptions.outFile)).replace(/\\/g, '/');
        }
        if (projectSpec.compilerOptions.outDir) {
          compilationTask.outDir = path.normalize(path.join(
            relativePathFromGruntfileToTSConfig(),
            projectSpec.compilerOptions.outDir)).replace(/\\/g, '/');
        }
    });
  }
  return options;
}

function getTSConfigSettings(raw: ITargetOptions): ITSConfigSupport {

  try {
    if (!raw || !raw.tsconfig) {
      return null;
    }

    if (typeof raw.tsconfig === 'boolean') {
      return {
        tsconfig: path.join(path.resolve('.'), 'tsconfig.json')
      };
    } else if (typeof raw.tsconfig === 'string') {

      let tsconfigName = templateProcessor(<string>raw.tsconfig, {});
      let fileInfo = fs.lstatSync(tsconfigName);

      if (fileInfo.isDirectory()) {
        tsconfigName = path.join(tsconfigName, 'tsconfig.json');
      }

      return {
        tsconfig: tsconfigName
      };
    }
    if (!('tsconfig' in <ITSConfigSupport>raw.tsconfig) &&
        !(<ITSConfigSupport>raw.tsconfig).passThrough) {
      (<ITSConfigSupport>raw.tsconfig).tsconfig = 'tsconfig.json';
    }
    return raw.tsconfig;
  } catch (ex) {
    if (ex.code === 'ENOENT') {
      throw ex;
    }
    let exception : NodeJS.ErrnoException = {
      name: 'Invalid tsconfig setting',
      message: 'Exception due to invalid tsconfig setting.  Details: ' + ex,
      code: ex.code,
      errno: ex.errno
    };
    throw exception;
  }
}

function applyCompilerOptions(applyTo: IGruntTSOptions, projectSpec: ITSConfigFile) {
  let result: IGruntTSOptions = applyTo || <any>{};
  const co = projectSpec.compilerOptions,
    tsconfig: ITSConfigSupport = applyTo.tsconfig;

  if (!tsconfig.ignoreSettings && co) {

    // Go here for the tsconfig.json documentation:
    // https://github.com/Microsoft/TypeScript-Handbook/blob/master/pages/tsconfig.json.md
    // There is a link to http://json.schemastore.org/tsconfig

    const sameNameInTSConfigAndGruntTS = [
      'allowJs',
      'allowSyntheticDefaultImports',
      'allowUnreachableCode',
      'allowUnusedLabels',
      'alwaysStrict',
      'baseUrl',
      'charset',
      'declaration',
      'declarationDir',
      'diagnostics',
      'emitBOM',
      'emitDecoratorMetadata',
      'experimentalAsyncFunctions',
      'experimentalDecorators',
      'forceConsistentCasingInFileNames',
      'isolatedModules',
      'importHelpers',
      'inlineSourceMap',
      'inlineSources',
      'jsx',
      'jsxFactory',
      'lib',
      'listEmittedFiles',
      'listFiles',
      'locale',
      'mapRoot',
      'maxNodeModuleJsDepth',
      'module',
      'moduleResolution',
      'newLine',
      'noEmit',
      'noEmitHelpers',
      'noEmitOnError',
      'noFallthroughCasesInSwitch',
      'noImplicitAny',
      'noImplicitReturns',
      'noImplicitThis',
      'noImplicitUseStrict',
      'noLib',
      'noResolve',
      'noUnusedLocals',
      'noUnusedParameters',
      'out',
      'outDir',
      // outFile is handled below.
      'preserveConstEnums',
      'pretty',
      'reactNamespace',
      'removeComments',
      'rootDir',
      'skipDefaultLibCheck',
      'sourceMap',
      'sourceRoot',
      'strictNullChecks',
      'stripInternal',
      'suppressExcessPropertyIndexErrors',
      'suppressImplicitAnyIndexErrors',
      'target',
      'traceResolution',
      'types',
      'typeRoots'
      // we do not support the native TypeScript watch.
    ];

    sameNameInTSConfigAndGruntTS.forEach(propertyName => {
      if ((propertyName in co) && !(propertyName in result)) {
          result[propertyName] = co[propertyName];
      }
    });

    // now copy the ones that don't have the same names.

    // `outFile` was added in TypeScript 1.6 and is the same as out for command-line
    // purposes except that `outFile` is relative to the tsconfig.json.
    if (('outFile' in co) && !('out' in result)) {
      result['out'] = co['outFile'];
    }
  }

  if (!('updateFiles' in tsconfig)) {
    tsconfig.updateFiles = !('include' in tsconfig) && ('filesGlob' in tsconfig);
  }

  if (applyTo.CompilationTasks.length === 0) {
    applyTo.CompilationTasks.push({src: []});
  }

  absolutePathToTSConfig = path.resolve(tsconfig.tsconfig, '..');

  if (tsconfig.overwriteFilesGlob) {
    if (!gruntfileGlobs) {
      throw new Error('The tsconfig option overwriteFilesGlob is set to true, but no glob was passed-in.');
    }

    const relPath = relativePathFromGruntfileToTSConfig(),
      gruntGlobsRelativeToTSConfig: string[] = [];

    for (let i = 0; i < gruntfileGlobs.length; i += 1) {
        gruntfileGlobs[i] = gruntfileGlobs[i].replace(/\\/g, '/');
        gruntGlobsRelativeToTSConfig.push(path.relative(relPath, gruntfileGlobs[i]).replace(/\\/g, '/'));
    }

    if (_.difference(projectSpec.filesGlob, gruntGlobsRelativeToTSConfig).length > 0 ||
        _.difference(gruntGlobsRelativeToTSConfig, projectSpec.filesGlob).length > 0) {
          projectSpec.filesGlob = gruntGlobsRelativeToTSConfig;
          if (projectSpec.files) {
            projectSpec.files = [];
          }
          saveTSConfigSync(tsconfig.tsconfig, projectSpec);
    }
  }

  result = addFilesToCompilationContext(result, projectSpec);

  return result;
}


function addFilesToCompilationContext(applyTo: IGruntTSOptions, projectSpec: ITSConfigFile) {
  // see http://www.typescriptlang.org/docs/handbook/tsconfig-json.html

  const resolvedInclude: string[] = [], resolvedExclude: string[] = [], resolvedFiles: string[] = [];

  if (projectSpec.exclude) {
    resolvedExclude.push(...(projectSpec.exclude.map(f => utils.prependIfNotStartsWith(path.join(absolutePathToTSConfig, f), '!'))));
  } else {
    resolvedExclude.push(utils.prependIfNotStartsWith(path.join(absolutePathToTSConfig, 'node_modules/**'), '!'),
      utils.prependIfNotStartsWith(path.join(absolutePathToTSConfig, 'bower_components/**'), '!'),
      utils.prependIfNotStartsWith(path.join(absolutePathToTSConfig, 'jspm_packages/**'), '!'));

    if (applyTo.CompilationTasks && applyTo.CompilationTasks.length > 0 && applyTo.CompilationTasks[0].outDir) {
      resolvedExclude.push(utils.prependIfNotStartsWith(path.join(absolutePathToTSConfig, applyTo.CompilationTasks[0].outDir), '!'));
    }
  }

  if (projectSpec.include || projectSpec.files) {
    if (projectSpec.files) {
      resolvedFiles.push(...projectSpec.files.map(f => path.join(absolutePathToTSConfig, f)));
    }
    if (_.isArray(projectSpec.include)) {
      resolvedInclude.push(...projectSpec.include.map(f => path.join(absolutePathToTSConfig, f)));
    }
  } else {
    resolvedInclude.push(
      path.join(absolutePathToTSConfig, '**/*.ts'),
      path.join(absolutePathToTSConfig, '**/*.d.ts'),
      path.join(absolutePathToTSConfig, '**/*.tsx')
    );
    if (applyTo.allowJs) {
      resolvedExclude.push(
        path.join(absolutePathToTSConfig, '**/*.js'),
        path.join(absolutePathToTSConfig, '**/*.jsx')
      );
    }
  }

  const result: IGruntTSOptions = applyTo,
    co = projectSpec.compilerOptions,
    tsconfig: ITSConfigSupport = applyTo.tsconfig,
    src = applyTo.CompilationTasks[0].src;

  const expandedCompilationContext: string[] = [];
  if (resolvedInclude.length > 0 || resolvedExclude.length > 0) {
    if ((globExpander as any).isStub) {
      result.warnings.push('Attempt to resolve glob in tsconfig module using stub globExpander.');
    }
    expandedCompilationContext.push(...globExpander([...resolvedInclude, ...resolvedExclude]));
  }
  expandedCompilationContext.push(...resolvedFiles);

  addUniqueRelativeFilesToSrc(expandedCompilationContext, src, absolutePathToTSConfig);

  if (tsconfig.updateFiles && projectSpec.filesGlob) {
    if (projectSpec.files === undefined) {
      projectSpec.files = [];
    }
    updateTSConfigAndFilesFromGlob(projectSpec.files, projectSpec.filesGlob, tsconfig.tsconfig);
  }


    // {
    //   const validPattern = result.allowJs ? /\.[tj]sx?$/i : /\.tsx?$/i;
    //   let excludedPaths: string[] = [];
    //   if (_.isArray(projectSpec.exclude)) {
    //     excludedPaths = projectSpec.exclude.map(filepath =>
    //       utils.makeRelativePath(absolutePathToTSConfig, path.resolve(absolutePathToTSConfig, filepath))
    //     );
    //   }

    //   const files =
    //       utils.getFiles(absolutePathToTSConfig, filepath =>
    //         excludedPaths.indexOf(utils.makeRelativePath(absolutePathToTSConfig, filepath)) > -1
    //         || (
    //           fs.statSync(filepath).isFile()
    //           && !validPattern.test(filepath)
    //         )
    //       ).map(filepath =>
    //         utils.makeRelativePath(absolutePathToTSConfig, filepath)
    //       );
    //   projectSpec.files = files;
    //   if (projectSpec.filesGlob) {
    //       saveTSConfigSync(tsconfig.tsconfig, projectSpec);
    //   }

    //   addUniqueRelativeFilesToSrc(files, src, absolutePathToTSConfig);
    // }
    return result;
}


function relativePathFromGruntfileToTSConfig() {
  if (!absolutePathToTSConfig) {
    throw 'attempt to get relative path to tsconfig.json before setting absolute path';
  }
  return path.relative('.', absolutePathToTSConfig).replace(/\\/g, '/');
}


function updateTSConfigAndFilesFromGlob(filesRelativeToTSConfig: string[],
      globRelativeToTSConfig: string[], tsconfigFileName: string) {

    if ((<any>globExpander).isStub) {
      return;
    }

    const absolutePathToTSConfig = path.resolve(tsconfigFileName, '..');

    let filesGlobRelativeToGruntfile: string[] = [];

    for (let i = 0; i < globRelativeToTSConfig.length; i += 1) {
      filesGlobRelativeToGruntfile.push(path.relative(path.resolve('.'), path.join(absolutePathToTSConfig, globRelativeToTSConfig[i])));
    }

    const filesRelativeToGruntfile = globExpander(filesGlobRelativeToGruntfile);

    {
      let filesRelativeToTSConfig_temp = [];
      const relativePathFromGruntfileToTSConfig = path.relative('.', absolutePathToTSConfig).replace(/\\/g, '/');
      for (let i = 0; i < filesRelativeToGruntfile.length; i += 1) {
        filesRelativeToGruntfile[i] = filesRelativeToGruntfile[i].replace(/\\/g, '/');
        filesRelativeToTSConfig_temp.push(path.relative(relativePathFromGruntfileToTSConfig, filesRelativeToGruntfile[i]).replace(/\\/g, '/'));
      }

      filesRelativeToTSConfig.length = 0;
      filesRelativeToTSConfig.push(...filesRelativeToTSConfig_temp);
    }

    const tsconfigJSONContent = utils.readAndParseJSONFromFileSync(tsconfigFileName);

    const tempTSConfigFiles = tsconfigJSONContent.files || [];

    if (_.difference(tempTSConfigFiles, filesRelativeToTSConfig).length > 0 ||
      _.difference(filesRelativeToTSConfig, tempTSConfigFiles).length > 0) {
        try {
          tsconfigJSONContent.files = filesRelativeToTSConfig;
          saveTSConfigSync(tsconfigFileName, tsconfigJSONContent);
        } catch (ex) {
          const error = new Error('Error updating tsconfig.json: ' + ex);
          throw error;
        }
    }
}

function saveTSConfigSync(fileName: string, content: any) {
    fs.writeFileSync(fileName, JSON.stringify(content, null, '    '));
}

const replaceSlashesRegex = new RegExp('\\' + path.sep, 'g');

function addUniqueRelativeFilesToSrc(tsconfigFilesArray: string[], compilationTaskSrc: string[], absolutePathToTSConfig: string) {
  const gruntfileFolder = path.resolve('.');

  _.map(_.uniq(tsconfigFilesArray), (file) => {
      const absolutePathToFile = path.isAbsolute(file) ? file : path.normalize(path.join(absolutePathToTSConfig, file));
      const relativePathToFileFromGruntfile = path.relative(gruntfileFolder, absolutePathToFile).replace(replaceSlashesRegex, '/');

      if (compilationTaskSrc.indexOf(absolutePathToFile) === -1 &&
          compilationTaskSrc.indexOf(relativePathToFileFromGruntfile) === -1) {
          compilationTaskSrc.push(relativePathToFileFromGruntfile);
      }
  });
}
