package au.csiro.data61.magda.indexer.crawler

import au.csiro.data61.magda.indexer.search.SearchIndexer
import scala.concurrent.Future

trait Crawler {
  def crawl(indexer: SearchIndexer): Future[Unit]
}