'use strict';

var $ = {
  _: require('lodash'),
  fs: require('fs'),
  lodash: require('lodash'),
  path: require('path'),
  glob: require('glob'),
  propprop: require('propprop')
};

function sortDependencies(a, b, referenceList) {
  return referenceList.indexOf(a) - referenceList.indexOf(b);
}

/**
 * Detect dependencies of the components from `bower.json`.
 *
 * @param  {object} config the global configuration object.
 * @return {object} config
 */
function detectDependencies(config) {
  var allDependencies = {};

  if (config.get('dependencies')) {
    $._.assign(allDependencies, config.get('package.json').dependencies);
  }

  if (config.get('dev-dependencies')) {
    $._.assign(allDependencies, config.get('package.json').devDependencies);
  }

  if (config.get('include-self')) {
    allDependencies[config.get('package.json').name] = config.get('package.json').version;
  }

  var referenceList = config.get("sortedDependenciesReferenceList");

  var reorderedDependencies = Object.fromEntries(
    Object.entries(allDependencies).sort(([a],[b]) => sortDependencies(a,b,referenceList))
  );

  $._.each(reorderedDependencies, gatherInfo(config));

  config.set('global-dependencies-sorted', filterExcludedDependencies(
    config.get('detectable-file-types').
      reduce(function (acc, fileType) {
        if (!acc[fileType]) {
          acc[fileType] = prioritizeDependencies(config, '.' + fileType);
        }
        return acc;
      }, {}),
    config.get('exclude')
  ));

  return config;
}


/**
 * Find the component's JSON configuration file.
 *
 * @param  {object} config     the global configuration object
 * @param  {string} component  the name of the component to dig for
 * @return {object} the component's config file
 */
function findComponentConfigFile(config, component) {
  var componentConfigFileObj = null;

  if (config.get('include-self') && component === config.get('package.json').name) {
    return config.get('package.json');
  }

  //make bower.json a priority, search package.json if there is no bower.json
  ['bower.json', '.bower.json', 'package.json', 'component.json'].
    forEach(function (configFile) {
      var fileName = configFile;
      configFile = $.path.join(config.get('node-directory'), component, configFile);

      if (!$._.isObject(componentConfigFileObj) && $.fs.existsSync(configFile)) {
        componentConfigFileObj = {};
        componentConfigFileObj.fileContent = JSON.parse($.fs.readFileSync(configFile));
        componentConfigFileObj.fileName = fileName;
      }
    });

  return componentConfigFileObj;
}


/**
 * Find the main file the component refers to. It's not always `main` :(
 *
 * @param  {object} config        the global configuration object
 * @param  {string} component     the name of the component to dig for
 * @param  {componentConfigFile}  the component's config file
 * @return {array} the array of paths to the component's primary file(s)
 */
function findMainFiles(config, component, componentConfigFile, configFileName) {
  var filePaths = [];
  var file = {};
  var self = config.get('include-self') && component === config.get('package.json').name;
  var cwd = self ? config.get('cwd') : $.path.join(config.get('node-directory'), component);

  function lastResortToFindFilePaths() {
     ['js', 'css']
      .forEach(function (type) {
        file[type] = $.path.join(config.get('node-directory'), component, componentConfigFile.name + '.' + type);

        if ($.fs.existsSync(file[type])) {
          filePaths.push(componentConfigFile.name + '.' + type);
        }
      });
  }

  if (/bower.json/.test(configFileName)) {
    if ($._.isString(componentConfigFile.main)) {
    // start by looking for what every component should have: config.main
      filePaths = [componentConfigFile.main];
    } else if ($._.isArray(componentConfigFile.main)) {
      filePaths = componentConfigFile.main;
    } else if ($._.isArray(componentConfigFile.scripts)) {
      // still haven't found it. is it stored in config.scripts, then?
      filePaths = componentConfigFile.scripts;
    } else {
      lastResortToFindFilePaths();
    }
  } else {
    if ($._.isArray(componentConfigFile.files)) {
      // start by looking at config.files
      var jsFiles = [];
      var jsMinFiles = [];

      var restOfFiles = [];

      for (var singleFile of componentConfigFile.files) {
        if (singleFile.slice(-3) === ".js") {
          if (singleFile.slice(-7) === ".min.js") {
            jsMinFiles.push(singleFile);
          }else {
            jsFiles.push(singleFile);
          }
        }else{
          restOfFiles.push(singleFile);
        }
      }

      for (var firstFile of jsMinFiles) {
        for (var secondFile of jsFiles) {
          if (secondFile === "index.js") {
            jsFiles = jsFiles.splice(jsFiles.indexOf(secondFile));
          } else if (secondFile.split(".min").join("") === firstFile) {
            jsFiles = jsFiles.splice(jsFiles.indexOf(secondFile));
          }
        }
      }

      restOfFiles = restOfFiles.concat(jsMinFiles);
      restOfFiles = restOfFiles.concat(jsFiles);

      filePaths = restOfFiles;
    } else if ($._.isString(componentConfigFile.files)) {
      filePaths = [componentConfigFile.files];
    } else if ($._.isString(componentConfigFile.main)) {
      // still haven't found it. is it stored in config.main
      filePaths = [componentConfigFile.main];
    } else {
      lastResortToFindFilePaths();
    }
  }

  return $._.uniq(filePaths.reduce(function (acc, filePath) {
    acc = acc.concat(
      $.glob.sync(filePath, { cwd: cwd, root: '/' })
        .map(function (path) {
          return $.path.join(cwd, path);
        })
    );
    return acc;
  }, []));
}


/**
 * Store the information our prioritizer will need to determine rank.
 *
 * @param  {object} config   the global configuration object
 * @return {function} the iterator function, called on every component
 */
function gatherInfo(config) {
  /**
   * The iterator function, which is called on each component.
   *
   * @param  {string} version    the version of the component
   * @param  {string} component  the name of the component
   * @return {undefined}
   */
  return function (version, component) {
    var dep = config.get('global-dependencies').get(component) || {
      main: '',
      type: '',
      name: '',
      dependencies: {}
    };

    var componentConfigFileObj = findComponentConfigFile(config, component);
    var componentConfigFile = componentConfigFileObj.fileContent;
    if (!componentConfigFile) {
      var error = new Error(component + ' is not installed. Try running `bower install` or remove the component from your bower.json file.');
      error.code = 'PKG_NOT_INSTALLED';
      config.get('on-error')(error);
      return;
    }

    var overrides = config.get('overrides');
    if (overrides && overrides[component]) {
      if (overrides[component].dependencies) {
        componentConfigFile.dependencies = overrides[component].dependencies;
      }

      if (/package.json/.test(componentConfigFileObj.fileName) && overrides[component].files) {
        componentConfigFile.files = overrides[component].files;
      }

      if (/package.json/.test(componentConfigFileObj.fileName) && overrides[component].main) {
        componentConfigFile.main = overrides[component].main.length ? overrides[component].main[0] : overrides[component].main;
      }

      if (/bower.json/.test(componentConfigFileObj.fileName) && overrides[component].main) {
        componentConfigFile.main = overrides[component].main;
      }
    }

    var mains = findMainFiles(config, component, componentConfigFile, componentConfigFileObj.fileName);
    var fileTypes = $._.chain(mains).map($.path.extname).uniq().value();

    dep.main = mains;
    dep.type = fileTypes;
    dep.name = componentConfigFile.name;

    var depIsExcluded = $._.find(config.get('exclude'), function (pattern) {
      return $.path.join(config.get('node-directory'), component).match(pattern);
    });

    if (dep.main.length === 0 && !depIsExcluded) {
      config.get('on-main-not-found')(component);
    }

    if (componentConfigFile.dependencies) {
      dep.dependencies = componentConfigFile.dependencies;
    }

    config.get('global-dependencies').set(component, dep);
  };
}


/**
 * Compare two dependencies to determine priority.
 *
 * @param  {object} a  dependency a
 * @param  {object} b  dependency b
 * @return {number} the priority of dependency a in comparison to dependency b
 */
function dependencyComparator(a, b) {
  var aNeedsB = false;
  var bNeedsA = false;

  aNeedsB = Object.
    keys(a.dependencies).
    some(function (dependency) {
      return dependency === b.name;
    });

  if (aNeedsB) {
    return 1;
  }

  bNeedsA = Object.
    keys(b.dependencies).
    some(function (dependency) {
      return dependency === a.name;
    });

  if (bNeedsA) {
    return -1;
  }

  return 0;
}


/**
 * Take two arrays, sort based on their dependency relationship, then merge them
 * together.
 *
 * @param  {array} left
 * @param  {array} right
 * @return {array} the sorted, merged array
 */
function merge(left, right) {
  var result = [];
  var leftIndex = 0;
  var rightIndex = 0;

  while (leftIndex < left.length && rightIndex < right.length) {
    if (dependencyComparator(left[leftIndex], right[rightIndex]) < 1) {
      result.push(left[leftIndex++]);
    } else {
      result.push(right[rightIndex++]);
    }
  }

  return result.
    concat(left.slice(leftIndex)).
    concat(right.slice(rightIndex));
}


/**
 * Take an array and slice it in halves, sorting each half along the way.
 *
 * @param  {array} items
 * @return {array} the sorted array
 */
function mergeSort(items) {
  if (items.length < 2) {
    return items;
  }

  var middle = Math.floor(items.length / 2);

  return merge(
    mergeSort(items.slice(0, middle)),
    mergeSort(items.slice(middle))
  );
}


/**
 * Sort the dependencies in the order we can best determine they're needed.
 *
 * @param  {object} config    the global configuration object
 * @param  {string} fileType  the type of file to prioritize
 * @return {array} the sorted items of 'path/to/main/files.ext' sorted by type
 */
 function prioritizeDependencies(config, fileType) {
  var globalDependencies = $._.toArray(config.get('global-dependencies').get());

  var dependencies = globalDependencies.filter(function (dependency) {
    return $._.includes(dependency.type, fileType);
  });

  return $._(mergeSort(dependencies)).
      map($.propprop('main')).
      flatten().
      value().
      filter(function (main) {
        return $.path.extname(main) === fileType;
      });
}


/**
 * Excludes dependencies that match any of the patterns.
 *
 * @param  {array} allDependencies  array of dependencies to filter
 * @param  {array} patterns         array of patterns to match against
 * @return {array} items that don't match any of the patterns
 */
function filterExcludedDependencies(allDependencies, patterns) {
  return $._.transform(allDependencies, function (result, dependencies, fileType) {
    result[fileType] = $._.reject(dependencies, function (dependency) {
      return $._.find(patterns, function (pattern) {
        return dependency.replace(/\\/g, '/').match(pattern);
      });
    });
  });
}


module.exports = detectDependencies;
