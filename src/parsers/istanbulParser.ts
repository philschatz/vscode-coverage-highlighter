import { ICoverage, IParser, CoverageColor, ICoverageReport, ICoverageFragmentBase, IParserInfo } from './../types';
import path from 'path';
import zipWith from 'lodash/zipWith';
import { CoverageFragment } from '../helpers/coverageFragment';
import { CoverageCollection } from '../helpers/coverageCollection';
import { CoverageFlatFragment } from '../helpers/coverageFlatFragmet';

namespace IIstanbul {
    /**
     * See https://github.com/gotwarlost/istanbul/blob/master/coverage.json.md
     */
    export type Report = IMap<IFile>;

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
        start: IIstanbulPosition;
        end: IIstanbulPosition;
        skip?: boolean
    }
    
    export interface IIstanbulPosition {
        line: number;
        column: number
    }
}


export class IstanbulParser implements IParser {
    public getInfo(): IParserInfo {
        return {
            name: 'istanbul',
            priority: 20,
            hasAdditionalColor: true
        }
    }

    constructor(private content: string, private folder: string) { }

    public static testFormat(ext: string, firstChunk: string): boolean {
        if (ext !== '.json') {
            return false;
        }
        return firstChunk.indexOf('"path":') !== -1;
    }

    public async getReport(): Promise<ICoverageReport> {
        // https://github.com/gotwarlost/istanbul/blob/master/coverage.json.md
        const content: IIstanbul.Report = JSON.parse(this.content);
        const all: ICoverage[] = [];
        
        for (const coverage of this.parse(content)) {
            all.push(coverage);
        }

        return all;
    }

    private *parse(content: IIstanbul.Report): IterableIterator<ICoverage> {
        for (let entry of Object.values(content)) {
            let filePath: string = entry.path;
            if (!path.isAbsolute(filePath)) {
                filePath = path.join(this.folder, filePath);
            }

            // Refactor it: just "else not taken" mark
            const branches = this.makeCollection<number[], IIstanbul.IBranch>(entry.b, entry.branchMap,
                (item) => item,
                (map_) => {
                    if (map_.type === 'if') {
                        // 'if' is a special case. TODO: Insert marker instead coverage region
                        return [];  // ignore them
                    } else {
                        return map_.locations
                    }
                },
                (map_) => map_.type);
            const statements = this.makeCollection<number, IIstanbul.ILocation>(entry.s, entry.statementMap,
                (item) => [item],
                (map_) => [map_]);
            const functions = this.makeCollection<number, IIstanbul.IFunction>(entry.f, entry.fnMap,
                (item) => [item],
                (map_) => map_.skip ? [] : [map_.loc]);

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

            const statementsPercent = statements.stat.total > 0 ? Math.ceil(statements.stat.covered * 100 / statements.stat.total) : 0;
            const branchesPercent = branches.stat.total > 0 ? Math.ceil(branches.stat.covered * 100 / branches.stat.total) : 0;
            const functionsPercent = functions.stat.total > 0 ? Math.ceil(functions.stat.covered * 100 / functions.stat.total) : 0;

            const tooltips = [
                `Statements: ${statementsPercent}% (${statements.stat.covered}/${statements.stat.total})`,
                `Branches: ${branchesPercent}% (${branches.stat.covered}/${branches.stat.total})`,
                `Functions: ${functionsPercent}% (${functions.stat.covered}/${functions.stat.total})`
            ];

            let totalPercent = 0;
            const covered = branches.stat.covered + statements.stat.covered + functions.stat.covered;
            const total = branches.stat.total + statements.stat.total + functions.stat.total;
            if (total > 0) {
                totalPercent = Math.ceil(covered * 100 / total);
            }

            const ret: ICoverage = {
                file: filePath,
                stat: {
                    label: `${totalPercent}%`,
                    tooltip: tooltips.join('\n')
                },
                fragments: coverage.dump(),
                parserInfo: this.getInfo()
            };
            yield ret;
        }
    }

    private makeCollection<A, T>(
        idsSource: IIstanbul.IMap<A>,
        mapSource: IIstanbul.IMap<T>,
        callbackIds: (e: A) => number[],
        callbackMap: (e: T) => IIstanbul.ILocation[],
        callbackMapNote?: (e: T) => string) {
            const collection = new CoverageCollection();

            for (const blockId of Object.keys(idsSource)) {
                const blockCounts = callbackIds(idsSource[blockId])
                const locations = callbackMap(mapSource[blockId]);
                const note = callbackMapNote ? callbackMapNote(mapSource[blockId]) : undefined;

                if (locations.length !== blockCounts.length) {
                    continue
                }

                zipWith(locations, blockCounts, (a, b) => {
                    if (a.start.line < 1 || a.end.line < 1) {
                        return;
                    }
                    if (a.start.column === 0 && a.end.column < 0) {
                        // oops. Sometimes it happens. With branches.
                        a.start.column = 0;
                        a.end.column = 1;
                    }
                    if (a.start.line && a.start.column && a.end.line && !a.end.column) {
                        // whole line in branches
                        a.end.column = 10000; // TODO: Fix it
                    }

                    if (a.start.column < 0 || a.end.column < 0) {
                        return
                    }
                    if (a.skip) {
                        return
                    }
                    // Sometimes start and end are swapped
                    if (a.start.line > a.end.line || (a.start.line === a.end.line && a.start.column > a.end.column)) {
                        [a.start, a.end] = [a.end, a.start];
                    }
                    const props: ICoverageFragmentBase = {
                        // make 0-based lines:
                        start: {line: a.start.line - 1, column: a.start.column},
                        end: {line: a.end.line - 1, column: a.end.column},
                        color: b > 0 ? CoverageColor.GREEN : CoverageColor.RED,
                        note: note
                    };
    
                    const fragment = new CoverageFragment(props);
                    collection.addItem(fragment);
                });
            }

            return collection;
    }
}
