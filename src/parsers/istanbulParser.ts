import { ICoverage, IParser, CoverageColor, ICoverageReport, ICoverageFragmentBase } from './../types';
import path from 'path';
import zipWith from 'lodash/zipWith';
import { CoverageFragment } from '../helpers/coverageFragment';
import { CoverageCollection } from '../helpers/coverageCollection';
import { CoverageFlatFragment } from '../helpers/coverageFlatFragmet';

namespace IIstambul {
    /**
     * See https://github.com/gotwarlost/istanbul/blob/master/coverage.json.md
     */
    export type Report = IMap<IFile>;
    // export type TStatements = IMap<number>;
    // export type TBranches = IMap<number[]>;
    // export type TFunctions = IMap<number>;
    // export type THash = number|number[];
    // export type TMap = IBranch|IFunction|ILocation;

    export interface IFile {
        path: string;
        l?: any;
        s: IMap<number>;
        statementMap: IMap<ILocation>;
        b: IMap<number[]>;
        branchMap: IMap<IBranch>;
        f: IMap<number>;
        fnMap: IMap<IFunction>;
    }
    
    export interface IMap<T> {
        [id: string]: T;
    }
    
    export interface IBranch {
        line: number;
        type: string;
        locations: ILocation[];
    }
    
    export interface IFunction {
        name: string;
        line: number;
        loc: ILocation;
        skip?: boolean;
    }
    
    export interface ILocation {
        start: IIstambulPosition;
        end: IIstambulPosition;
        skip?: boolean
    }
    
    export interface IIstambulPosition {
        line: number;
        column: number
    }
}


export class IstanbulParser implements IParser {
    public name = 'istambul';
    public priority = 20;

    constructor(private content: string, private folder: string) { }

    public static testFormat(ext: string, firstChunk: string): boolean {
        if (ext !== '.json') {
            return false;
        }
        return firstChunk.indexOf('"path":') !== -1;
    }

    public async getReport(): Promise<ICoverageReport> {
        // https://github.com/gotwarlost/istanbul/blob/master/coverage.json.md
        const content: IIstambul.Report = JSON.parse(this.content);
        const all: ICoverage[] = [];
        
        for (const coverage of this.parse(content)) {
            all.push(coverage);
        }

        return all;
    }

    private *parse(content: IIstambul.Report): IterableIterator<ICoverage> {
        for (let entry of Object.values(content)) {
            // entry = {path: '', b: [], branchMap: {}, s: [], statementMap: {}, f: [], fnMap: {}, ...entry}
            let filePath: string = entry.path;
            if (!path.isAbsolute(filePath)) {
                filePath = path.join(this.folder, filePath);
            }

            const branches = this.makeCollection<number[], IIstambul.IBranch>(entry.b, entry.branchMap,
                (item) => item,
                (item) => item.locations);
            const statements = this.makeCollection<number, IIstambul.ILocation>(entry.s, entry.statementMap,
                (item) => [item],
                (item) => [item]);
            const functions = this.makeCollection<number, IIstambul.IFunction>(entry.f, entry.fnMap,
                (item) => [item],
                (item) => [item.loc]);

            const coverage = new CoverageCollection();
            coverage
                .merge(branches)
                .merge(statements)
                .merge(functions)
                .normalize();

            // Add green bg layer
            const bgCollection = new CoverageCollection();
            for (const i of coverage.items) {
                if (i.color === CoverageColor.GREEN) {
                    bgCollection.addItem(new CoverageFlatFragment({start: {line: i.start.line}, end: {line: i.end.line}, color: CoverageColor.GREEN_BG, note: i.note}));
                }
            }
            bgCollection.normalize();
            coverage.merge(bgCollection);

            const tooltips = [
                `Statements: ${Math.ceil(statements.stat.covered * 100 / statements.stat.total)}% (${statements.stat.covered}/${statements.stat.total})`,
                `Branches: ${Math.ceil(branches.stat.covered * 100 / branches.stat.total)}% (${branches.stat.covered}/${branches.stat.total})`,
                `Functions: ${Math.ceil(functions.stat.covered * 100 / functions.stat.total)}% (${functions.stat.covered}/${functions.stat.total})`
            ];

            let percent = 100;
            const covered = branches.stat.covered + statements.stat.covered + functions.stat.covered;
            const total = branches.stat.total + statements.stat.total + functions.stat.total;
            if (total > 0) {
                percent = Math.ceil(covered * 100 / total);
            }

            const ret: ICoverage = {
                priority: this.priority,
                file: filePath,
                stat: {
                    label: `${percent}%`,
                    tooltip: tooltips.join('\n')
                },
                fragments: coverage.dump(),
                withGreenBg: true
            };
            yield ret;
        }
    }

    private makeCollection<A, T>(
        idsSource: IIstambul.IMap<A>,
        mapSource: IIstambul.IMap<T>,
        callbackIds: (e: A) => number[],
        callbackMap: (e: T) => IIstambul.ILocation[]) {
            const collection = new CoverageCollection();

            for (const blockId of Object.keys(idsSource)) {
                const blockCounts = callbackIds(idsSource[blockId])
                const locations = callbackMap(mapSource[blockId]);

                zipWith(locations, blockCounts, (a, b) => {
                    if (a.start.line < 1 || a.end.line < 1) {
                        return;
                    }
                    // Sometimes start and end could contain warning values
                    if (a.start.line === a.end.line && a.start.column > a.end.column) {
                        [a.start, a.end] = [a.end, a.start];
                    }
                    const props: ICoverageFragmentBase = {
                        // make 0-based lines:
                        start: {line: a.start.line - 1, column: a.start.column},
                        end: {line: a.end.line - 1, column: a.end.column},
                        color: b > 0 ? CoverageColor.GREEN : CoverageColor.RED
                    };
    
                    const fragment = new CoverageFragment(props);
                    collection.addItem(fragment);
                });
            }

            return collection;
    }
}
