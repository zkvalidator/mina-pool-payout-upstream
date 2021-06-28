
import { injectable } from "inversify";
import { IBlockDataProvider } from "./Models";
import { getBlocks, getLatestHeight } from "./dataprovider-minaexplorer/block-queries-gql";
import { Blocks } from "./dataprovider-types";

@injectable()
export class MinaExplorerBlockDataProvider implements IBlockDataProvider{
    getLatestHeight(): Promise<number> {
        return getLatestHeight()
    }
    async getBlocks(key: string, minHeight: number, maxHeight: number): Promise<Blocks> {
        return await getBlocks(key, minHeight, maxHeight)
    }

}